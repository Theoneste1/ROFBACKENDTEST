import { NotFoundException } from '@nestjs/common';
import { LeaderboardService } from './leaderboard.service.js';
import type { AuthUser } from '../common/auth-user.js';

const STUDENT: AuthUser = { id: 's1', username: 'stu',   role: 'STUDENT', divisionId: 'd1', gradeLevel: 'S2' };
const ADMIN:   AuthUser = { id: 'a1', username: 'admin', role: 'ADMIN',   divisionId: null, gradeLevel: null };

const row = (overrides: Record<string, unknown> = {}) => ({
  rank: 1n, id: 's2', firstName: 'Grace', lastName: 'Uwase', avatarUrl: null,
  points: 100, problemsSolved: 4, schoolId: 'sch1', schoolName: 'GS Kigali', ...overrides,
});

function makeMocks() {
  const prisma = {
    $queryRaw: vi.fn(),
    user:      { count: vi.fn().mockResolvedValue(0) },
    school:    { count: vi.fn().mockResolvedValue(0) },
    division:  { findUnique: vi.fn().mockResolvedValue({ id: 'd1' }) },
  };
  const settings = { get: vi.fn().mockResolvedValue(true) };
  const access   = {
    studentDivision: vi.fn((u: AuthUser) => u.divisionId),
  };
  const service = new LeaderboardService(prisma as any, settings as any, access as any);
  return { service, prisma, settings, access };
}

describe('LeaderboardService', () => {
  describe('division resolution', () => {
    it('hides the leaderboard from students when the setting is off', async () => {
      const { service, prisma, settings } = makeMocks();
      settings.get.mockResolvedValue(false);
      await expect(service.findGeneral(STUDENT, {})).rejects.toMatchObject({ code: 'LEADERBOARD_HIDDEN', status: 403 });
      expect(settings.get).toHaveBeenCalledWith('leaderboard.visibleToStudents');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('applies the setting to findMine too', async () => {
      const { service, settings } = makeMocks();
      settings.get.mockResolvedValue(false);
      await expect(service.findMine(STUDENT)).rejects.toMatchObject({ code: 'LEADERBOARD_HIDDEN' });
    });

    it('requires staff to specify a division', async () => {
      const { service } = makeMocks();
      await expect(service.findGeneral(ADMIN, {})).rejects.toMatchObject({ code: 'DIVISION_REQUIRED', status: 400 });
    });

    it('returns 404 for an unknown division', async () => {
      const { service, prisma } = makeMocks();
      prisma.division.findUnique.mockResolvedValue(null);
      await expect(service.findGeneral(ADMIN, { divisionId: 'nope' } as any)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('students always get their own division, ignoring a requested one', async () => {
      const { service, prisma } = makeMocks();
      prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0n }]);
      const result = await service.findGeneral(STUDENT, { divisionId: 'd-other' } as any);
      expect(result.divisionId).toBe('d1');
      expect(prisma.division.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('findGeneral', () => {
    it('shows students first name + last initial and flags their own row', async () => {
      const { service, prisma } = makeMocks();
      prisma.$queryRaw
        .mockResolvedValueOnce([row(), row({ id: 's1', rank: 2n, firstName: 'Me', lastName: 'Self', schoolId: null })])
        .mockResolvedValueOnce([{ count: 2n }]);

      const result = await service.findGeneral(STUDENT, {});

      expect(result.data[0]).toEqual({
        rank: 1, id: 's2', displayName: 'Grace U.', avatarUrl: null, points: 100, problemsSolved: 4,
        school: { id: 'sch1', name: 'GS Kigali' }, isMe: false,
      });
      expect(result.data[1]).toMatchObject({ rank: 2, isMe: true, school: null });
      expect(result.meta).toEqual({ total: 2, page: 1, limit: 20, totalPages: 1 });
    });

    it('shows staff full names', async () => {
      const { service, prisma } = makeMocks();
      prisma.$queryRaw.mockResolvedValueOnce([row()]).mockResolvedValueOnce([{ count: 1n }]);
      const result = await service.findGeneral(ADMIN, { divisionId: 'd1' } as any);
      expect(result.data[0].displayName).toBe('Grace Uwase');
    });
  });

  describe('findMine', () => {
    it('returns the student position', async () => {
      const { service, prisma } = makeMocks();
      prisma.$queryRaw.mockResolvedValue([row({ id: 's1', rank: 3n, points: 50, problemsSolved: 2 })]);
      prisma.user.count.mockResolvedValue(10);
      await expect(service.findMine(STUDENT)).resolves.toEqual({
        divisionId: 'd1', rank: 3, outOf: 10, points: 50, problemsSolved: 2,
      });
    });

    it('returns a null rank when the student is not ranked', async () => {
      const { service, prisma } = makeMocks();
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.findMine(STUDENT)).resolves.toMatchObject({ rank: null, points: 0, problemsSolved: 0 });
    });
  });

  describe('findSchoolSummary', () => {
    it('converts bigint aggregates to numbers', async () => {
      const { service, prisma } = makeMocks();
      prisma.$queryRaw.mockResolvedValue([{
        rank: 1n, schoolId: 'sch1', schoolName: 'GS Kigali', schoolLocation: 'Kigali',
        totalPoints: 300n, studentCount: 3n, averagePoints: 100,
      }]);
      prisma.school.count.mockResolvedValue(1);
      const result = await service.findSchoolSummary(ADMIN, { divisionId: 'd1' } as any);
      expect(result.data).toEqual([{
        rank: 1, schoolId: 'sch1', schoolName: 'GS Kigali', schoolLocation: 'Kigali',
        totalPoints: 300, studentCount: 3, averagePoints: 100,
      }]);
    });
  });
});
