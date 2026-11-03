import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service.js';

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
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));

  const audit     = { log: vi.fn() };
  const divisions = {
    idForGrade: vi.fn().mockResolvedValue('div-x'),
    idForCode:  vi.fn((code: string) => Promise.resolve(`div-${code.toLowerCase()}`)),
  };
  const tokens    = { revokeAllForUser: vi.fn() };
  const academicYears = { enrollInCurrentYear: vi.fn().mockResolvedValue({ id: 'enr1' }) };

  const service = new UsersService(prisma as any, audit as any, divisions as any, tokens as any, academicYears as any);
  return { service, prisma, audit, divisions, tokens, academicYears };
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
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE_USER_STATUS' }));
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

    it('clears student data and revokes sessions when a student becomes a mentor', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findUnique.mockResolvedValue(existing);
      await service.update('u2', { role: 'MENTOR' } as any, ADMIN);
      expect(prisma.user.update.mock.calls[0][0].data).toMatchObject({
        role: 'MENTOR', gradeLevel: null, divisionId: null, schoolId: null, homeLocation: null,
      });
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith('u2');
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
});
