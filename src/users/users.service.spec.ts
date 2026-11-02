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
    },
    school: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));

  const audit     = { log: vi.fn() };
  const divisions = {
    idForGrade: vi.fn().mockResolvedValue('div-x'),
    idForCode:  vi.fn((code: string) => Promise.resolve(`div-${code.toLowerCase()}`)),
  };
  const tokens    = { revokeAllForUser: vi.fn() };

  const service = new UsersService(prisma as any, audit as any, divisions as any, tokens as any);
  return { service, prisma, audit, divisions, tokens };
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
  });

  describe('updateMe', () => {
    it('requires at least one field', async () => {
      const { service } = makeMocks();
      await expect(service.updateMe('u1', {})).rejects.toMatchObject({ code: 'NO_CHANGES' });
    });
  });

  describe('promoteStudents', () => {
    it('promotes top-down, moves S3→S4 into the senior division and graduates S6 when asked', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.updateMany.mockResolvedValue({ count: 2 });

      const result = await service.promoteStudents(true, ADMIN);

      const calls = prisma.user.updateMany.mock.calls.map((c) => c[0]);
      expect(calls[0]).toEqual({
        where: { role: 'STUDENT', gradeLevel: 'S6', isActive: true },
        data:  { isActive: false },
      });
      expect(calls.map((c) => c.where.gradeLevel)).toEqual(['S6', 'S5', 'S4', 'S3', 'S2', 'S1']);
      const s3 = calls.find((c) => c.where.gradeLevel === 'S3')!;
      expect(s3.data).toEqual({ gradeLevel: 'S4', divisionId: 'div-senior' });
      const s1 = calls.find((c) => c.where.gradeLevel === 'S1')!;
      expect(s1.data).toEqual({ gradeLevel: 'S2', divisionId: 'div-junior' });
      expect(result.promoted).toMatchObject({ graduated: 2, 'S5->S6': 2, 'S1->S2': 2 });
    });

    it('leaves S6 students untouched when not graduating', async () => {
      const { service, prisma } = makeMocks();
      await service.promoteStudents(false, ADMIN);
      const grades = prisma.user.updateMany.mock.calls.map((c) => c[0].where.gradeLevel);
      expect(grades).not.toContain('S6');
    });
  });
});
