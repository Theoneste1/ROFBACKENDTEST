import { NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { UsersService } from './users.service.js';

/** The acting admin's password and hash, for step-up (P1-08). */
const STEP_UP = 'Admin-Pass-1';
const STEP_UP_HASH = bcrypt.hashSync(STEP_UP, 4);
/** findUnique answers the caller's own row (step-up) and the target row. */
const withCaller = (target: unknown) => (args: { where: { id: string } }) =>
  Promise.resolve(args.where.id === 'admin-1' ? { passwordHash: STEP_UP_HASH } : target);

const ADMIN = { id: 'admin-1', role: 'ADMIN' };

function makeMocks() {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'u2', username: 'bob' }),
      findFirst:  vi.fn().mockResolvedValue(null),
      update:     vi.fn().mockResolvedValue({ id: 'u2' }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete:     vi.fn().mockResolvedValue({}),
      create:     vi.fn().mockResolvedValue({ id: 'u-new' }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'u-new', username: 'newbie' }),
    },
    school: { findUnique: vi.fn() },
    studentEnrollment: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    mentorAssignment:  { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // P1-11: a role change revokes teacher delegations (none here).
    userPermissionOverride: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    mentorReview:      { count: vi.fn().mockResolvedValue(0) },
    discipline:          { findMany: vi.fn().mockResolvedValue([{ id: 'd-math', code: 'MATHEMATICS' }]) },
    programmeMembership: { upsert: vi.fn().mockResolvedValue({}) },
    // Admin edits lock the user row first (PR A.1).
    $queryRaw: vi.fn().mockResolvedValue([{ schoolId: null }]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));

  const audit     = { log: vi.fn() };
  const divisions = {
    idForGrade: vi.fn().mockResolvedValue('div-x'),
    idForCode:  vi.fn((code: string) => Promise.resolve(`div-${code.toLowerCase()}`)),
  };
  const tokens    = { revokeAllForUser: vi.fn(), lockSessions: vi.fn() };
  const academicYears = { enrollInCurrentYear: vi.fn().mockResolvedValue({ id: 'enr1' }) };

  const accountEmails = { approved: vi.fn() };
  const roles = { assertCanAssign: vi.fn(), assertCanManage: vi.fn() };
  const affiliations = { claim: vi.fn().mockResolvedValue('aff1'), supersede: vi.fn(), beginUserChange: vi.fn().mockResolvedValue(null) };
  const service = new UsersService(prisma as any, audit as any, divisions as any, tokens as any, academicYears as any, accountEmails as any, roles as any, affiliations as any);
  return { service, prisma, audit, divisions, tokens, academicYears, accountEmails, roles, affiliations };
}

describe('UsersService', () => {
  describe('updateStatus', () => {
    it('refuses to suspend yourself', async () => {
      const { service, prisma } = makeMocks();
      await expect(service.updateStatus(ADMIN.id, { isActive: false }, ADMIN))
        .rejects.toMatchObject({ code: 'CANNOT_SUSPEND_SELF', status: 400 });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('revokes sessions when suspending another user', async () => {
      const { service, prisma, tokens, audit } = makeMocks();
      await service.updateStatus('u2', { isActive: false }, ADMIN);
      expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ isActive: false });
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith('u2');
      // Written in the same transaction as the change (second argument).
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'UPDATE_USER_STATUS' }),
        prisma,
      );
    });

    it('does not revoke sessions when only approving', async () => {
      const { service, tokens } = makeMocks();
      await service.updateStatus('u2', { isApproved: true }, ADMIN);
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('refuses to delete yourself', async () => {
      const { service, prisma } = makeMocks();
      await expect(service.delete(ADMIN.id, ADMIN)).rejects.toMatchObject({ code: 'CANNOT_DELETE_SELF' });
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown user', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.delete('u404', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps a foreign-key violation (P2003) to USER_HAS_HISTORY', async () => {
      const { service, prisma, audit } = makeMocks();
      prisma.user.delete.mockRejectedValue({ code: 'P2003' });
      await expect(service.delete('u2', ADMIN)).rejects.toMatchObject({ code: 'USER_HAS_HISTORY', status: 409 });
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('rethrows unrelated errors', async () => {
      const { service, prisma } = makeMocks();
      const boom = new Error('db down');
      prisma.user.delete.mockRejectedValue(boom);
      await expect(service.delete('u2', ADMIN)).rejects.toBe(boom);
    });

    it('deletes and audits a user without history', async () => {
      const { service, prisma, audit } = makeMocks();
      await expect(service.delete('u2', ADMIN)).resolves.toEqual({ message: 'User u2 deleted successfully.' });
      expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u2' } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'DELETE_USER', metadata: { username: 'bob' },
      }));
    });
  });

  describe('update', () => {
    const existing = { id: 'u2', role: 'STUDENT', gradeLevel: 'S2', username: 'bob', email: 'bob@x.rw' };

    it('requires at least one field', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(existing);
      await expect(service.update('u2', {}, ADMIN)).rejects.toMatchObject({ code: 'NO_CHANGES' });
    });

    it('refuses to change your own role', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ ...existing, id: ADMIN.id, role: 'ADMIN' });
      await expect(service.update(ADMIN.id, { role: 'MENTOR' } as any, ADMIN))
        .rejects.toMatchObject({ code: 'CANNOT_CHANGE_OWN_ROLE' });
    });

    it('rejects a username already in use', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(existing);
      prisma.user.findFirst.mockResolvedValue({ id: 'u3' });
      await expect(service.update('u2', { username: 'taken' } as any, ADMIN))
        .rejects.toMatchObject({ code: 'IDENTITY_TAKEN' });
    });

    it('refuses (409 USER_CHANGED_CONCURRENTLY) when the user changed between the first read and the row lock — nothing is written', async () => {
      const { service, prisma, audit } = makeMocks();
      // First read: STUDENT; inside the transaction, after the lock: already MENTOR (another edit committed).
      prisma.user.findUnique.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, role: 'MENTOR', gradeLevel: null });
      await expect(service.update('u2', { firstName: 'Stale' } as any, ADMIN)).rejects.toMatchObject({ code: 'USER_CHANGED_CONCURRENTLY' });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('clears student data and revokes sessions when a student becomes a mentor', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(existing);
      await service.update('u2', { role: 'MENTOR' } as any, ADMIN);
      expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
        role: 'MENTOR', gradeLevel: null, divisionId: null, schoolId: null, homeLocation: null,
      });
      // Revoked with the transaction client: commits together with the role change.
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith('u2', prisma);
    });

    it.each([
      ['a role change', { role: 'ADMIN', currentPassword: STEP_UP }],
      ['a password change', { password: 'N3w!Passw0rd' }],
    ])('ends sessions INSIDE the same transaction as %s, after the user row is written', async (_, data) => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findUnique.mockImplementation(withCaller({ ...existing, role: 'MENTOR', gradeLevel: null }));
      const tx = { ...prisma, marker: 'tx' };
      let inTransaction = false;
      prisma.$transaction.mockImplementation(async (fn: (c: unknown) => unknown) => {
        inTransaction = true;
        try { return await fn(tx); } finally { inTransaction = false; }
      });
      const seen: Array<{ inTransaction: boolean; client: unknown }> = [];
      tokens.revokeAllForUser.mockImplementation(async (_id: string, client: unknown) => { seen.push({ inTransaction, client }); });

      await service.update('u2', data as any, ADMIN);

      expect(seen).toEqual([{ inTransaction: true, client: tx }]);
      // The role / password update ran before the revocation, in the same transaction.
      expect(prisma.user.update.mock.invocationCallOrder[0]).toBeLessThan(tokens.revokeAllForUser.mock.invocationCallOrder[0]);
    });

    it('does not end sessions for a change without role or password', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(existing);
      await service.update('u2', { firstName: 'New' } as any, ADMIN);
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
      expect(tokens.lockSessions).not.toHaveBeenCalled();
    });

    // Deadlock regression (lock order sessions → User row, token.service.ts): a refresh of this user
    // holds the session lock and needs KEY SHARE on the User row; locking the row first would deadlock.
    it.each([
      ['a role change', { role: 'ADMIN', currentPassword: STEP_UP }],
      ['a password change', { password: 'N3w!Passw0rd' }],
    ])('%s takes the session lock BEFORE the User row lock, in the same transaction', async (_, data) => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findUnique.mockImplementation(withCaller({ ...existing, role: 'MENTOR', gradeLevel: null }));
      const tx = { ...prisma, marker: 'tx' };
      prisma.$transaction.mockImplementation(async (fn: (c: unknown) => unknown) => fn(tx));

      await service.update('u2', data as any, ADMIN);

      expect(tokens.lockSessions).toHaveBeenCalledWith(tx, 'u2');
      const rowLock = prisma.$queryRaw.mock.calls.findIndex((call: unknown[]) => (call[0] as TemplateStringsArray).join('?').includes('FOR UPDATE'));
      expect(rowLock).toBeGreaterThanOrEqual(0);
      expect(tokens.lockSessions.mock.invocationCallOrder[0]).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[rowLock]);
      expect(tokens.lockSessions.mock.invocationCallOrder[0]).toBeLessThan(tokens.revokeAllForUser.mock.invocationCallOrder[0]);
    });

    it('withdraws the active enrolment when a student becomes a mentor', async () => {
      const { service, prisma, academicYears } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(existing);
      await service.update('u2', { role: 'MENTOR' } as any, ADMIN);
      expect(prisma.studentEnrollment.updateMany.mock.calls[0][0]).toMatchObject({
        where: { studentId: 'u2', status: 'ACTIVE' }, data: { status: 'WITHDRAWN' },
      });
      expect(academicYears.enrollInCurrentYear).not.toHaveBeenCalled();
    });

    it('re-enrols a student in the current year when their grade changes', async () => {
      const { service, prisma, divisions, academicYears } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(existing);
      prisma.user.update.mockResolvedValue({ schoolId: 'sch1' });
      await service.update('u2', { gradeLevel: 'S4' } as any, ADMIN);
      expect(divisions.idForGrade).toHaveBeenCalledWith('S4');
      expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({ gradeLevel: 'S4', divisionId: 'div-x' });
      expect(academicYears.enrollInCurrentYear).toHaveBeenCalledWith(prisma, 'u2', 'S4', 'sch1');
    });

    it('does not touch enrolment when only the name changes', async () => {
      const { service, prisma, academicYears } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(existing);
      await service.update('u2', { firstName: 'Bobby' } as any, ADMIN);
      expect(academicYears.enrollInCurrentYear).not.toHaveBeenCalled();
      expect(prisma.studentEnrollment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    const dto = (overrides: Record<string, unknown> = {}) => ({
      firstName: 'N', lastName: 'B', username: 'newbie', email: 'n@x.rw', password: 'Passw0rd!!',
      gradeLevel: 'S1', ...overrides,
    }) as any;

    it('creates a student and enrols them in the current academic year within the transaction', async () => {
      const { service, prisma, academicYears, audit } = makeMocks();
      const user = await service.create(dto(), ADMIN);
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({ role: 'STUDENT', gradeLevel: 'S1', divisionId: 'div-x' });
      expect(academicYears.enrollInCurrentYear).toHaveBeenCalledWith(prisma, 'u-new', 'S1', null);
      expect(user).toEqual({ id: 'u-new', username: 'newbie' });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE_USER', entityId: 'u-new' }));
    });

    it('does not enrol mentors', async () => {
      const { service, prisma, academicYears } = makeMocks();
      await service.create(dto({ role: 'MENTOR', gradeLevel: undefined }), ADMIN);
      expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({ role: 'MENTOR', homeLocation: null });
      expect(academicYears.enrollInCurrentYear).not.toHaveBeenCalled();
    });

    it('fails (and audits nothing) when enrolment fails', async () => {
      const { service, academicYears, audit } = makeMocks();
      academicYears.enrollInCurrentYear.mockRejectedValue(Object.assign(new Error('none'), { code: 'NO_CURRENT_ACADEMIC_YEAR' }));
      await expect(service.create(dto(), ADMIN)).rejects.toMatchObject({ code: 'NO_CURRENT_ACADEMIC_YEAR' });
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('updateMe', () => {
    it('requires at least one field', async () => {
      const { service } = makeMocks();
      await expect(service.updateMe('u1', {})).rejects.toMatchObject({ code: 'NO_CHANGES' });
    });
  });

  describe('role allow-list (P1-05)', () => {
    const refusal = () => Object.assign(new Error('refused'), { code: 'ROLE_NOT_ASSIGNABLE' });

    it('create checks the requested role (default STUDENT) before writing anything', async () => {
      const { service, prisma, roles } = makeMocks();
      roles.assertCanAssign.mockImplementation(() => { throw refusal(); });
      await expect(service.create({ role: 'SUPER_ADMIN' } as any, ADMIN)).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
      expect(roles.assertCanAssign).toHaveBeenCalledWith(ADMIN, 'SUPER_ADMIN');
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();

      const ok = makeMocks();
      await ok.service.create({ firstName: 'a' } as any, ADMIN).catch(() => undefined);
      expect(ok.roles.assertCanAssign).toHaveBeenCalledWith(ADMIN, 'STUDENT');
    });

    it('update checks the CURRENT role on every edit, and the NEW role only when it changes', async () => {
      const { service, prisma, roles } = makeMocks();
      prisma.user.findUnique.mockImplementation(withCaller({ id: 'u2', role: 'MENTOR', gradeLevel: null, username: 'bob', email: 'b@x.rw' }));
      await service.update('u2', { firstName: 'New' } as any, ADMIN);
      expect(roles.assertCanManage).toHaveBeenCalledWith(ADMIN, 'MENTOR');
      expect(roles.assertCanAssign).not.toHaveBeenCalled();

      await service.update('u2', { role: 'ADMIN', currentPassword: STEP_UP } as any, ADMIN);
      expect(roles.assertCanAssign).toHaveBeenCalledWith(ADMIN, 'ADMIN', 'roleChange');
    });

    it('a refused role change writes nothing and ends no session', async () => {
      const { service, prisma, roles, tokens } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'u2', role: 'STUDENT', gradeLevel: 'S2', username: 'bob', email: 'b@x.rw' });
      roles.assertCanAssign.mockImplementation(() => { throw refusal(); });
      await expect(service.update('u2', { role: 'TEACHER' } as any, ADMIN)).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });

    it('an account whose current role the actor may not manage cannot be edited, suspended or deleted', async () => {
      const { service, prisma, roles } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'u2', role: 'SUPER_ADMIN', gradeLevel: null, username: 'sa', email: 's@x.rw' });
      roles.assertCanManage.mockImplementation(() => { throw refusal(); });
      await expect(service.update('u2', { firstName: 'X' } as any, ADMIN)).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
      await expect(service.updateStatus('u2', { isActive: false }, ADMIN)).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
      await expect(service.delete('u2', ADMIN)).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
      expect(roles.assertCanManage).toHaveBeenCalledTimes(3);
    });
  });
});
