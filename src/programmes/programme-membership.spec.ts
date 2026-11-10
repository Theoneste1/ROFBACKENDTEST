import { readFileSync } from 'fs';
import { join } from 'path';

import { ensureDefaultMembership } from './programme-membership.js';

function tx(disciplines: Array<{ id: string; code: string }>) {
  return {
    discipline:          { findMany: vi.fn().mockResolvedValue(disciplines) },
    programmeMembership: { upsert: vi.fn().mockResolvedValue({}) },
  };
}
const MATHS = { id: 'd-math', code: 'MATHEMATICS' };

describe('ensureDefaultMembership (P1-07, K6)', () => {
  it.each(['STUDENT', 'MENTOR'])('%s gets a MANUAL Mathematics membership with the acting user', async (role) => {
    const t = tx([MATHS]);
    await expect(ensureDefaultMembership(t as never, { id: 'u1', role }, 'admin-1')).resolves.toEqual({ disciplineId: 'd-math' });
    expect(t.programmeMembership.upsert).toHaveBeenCalledWith({
      where:  { userId_disciplineId: { userId: 'u1', disciplineId: 'd-math' } },
      create: { userId: 'u1', disciplineId: 'd-math', source: 'MANUAL', addedById: 'admin-1' },
      update: {},   // an existing (possibly ended) membership is left exactly as it is
    });
  });

  it('self-registration has no actor (addedById NULL)', async () => {
    const t = tx([MATHS]);
    await ensureDefaultMembership(t as never, { id: 'u1', role: 'STUDENT' }, null);
    expect(t.programmeMembership.upsert.mock.calls[0][0].create.addedById).toBeNull();
  });

  it.each(['ADMIN', 'SUPER_ADMIN', 'TEACHER', 'HEAD_COACH', 'UNKNOWN_ROLE'])('%s gets none (and the programmes are not even read)', async (role) => {
    const t = tx([MATHS]);
    await expect(ensureDefaultMembership(t as never, { id: 'u1', role }, 'admin-1')).resolves.toBeNull();
    expect(t.discipline.findMany).not.toHaveBeenCalled();
    expect(t.programmeMembership.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['no programme', []],
    ['two programmes', [MATHS, { id: 'd-phys', code: 'PHYSICS' }]],
    ['one programme that is not Mathematics', [{ id: 'd-phys', code: 'PHYSICS' }]],
  ])('%s → none (choosing a programme is later work)', async (_, disciplines) => {
    const t = tx(disciplines);
    await expect(ensureDefaultMembership(t as never, { id: 'u1', role: 'STUDENT' }, null)).resolves.toBeNull();
    expect(t.programmeMembership.upsert).not.toHaveBeenCalled();
  });
});

describe('membership never feeds student or coach access (plan §7.3, §11.5 code guard)', () => {
  const SRC = join(__dirname, '..');
  const read = (p: string) => readFileSync(join(SRC, p), 'utf8');

  it.each([
    'courses/courses.service.ts', 'courses/course-resources.service.ts', 'assignments/assignments.service.ts',
    'submissions/submissions.service.ts', 'discussions/discussions.service.ts', 'leaderboard/leaderboard.service.ts',
    'analytics/analytics.service.ts', 'auth/strategies/jwt.strategy.ts',
    'auth/guards/roles.guard.ts', 'auth/guards/permission.guard.ts', 'auth/permission.service.ts',
  ])('%s does not read programme membership', (file) => {
    expect(read(file)).not.toMatch(/programmeMembership|ProgrammeMembership|programmesOf|isProgrammeMember|programmeMembersFilter|programmeCoursesFilter/);
  });

  it('mentor-assignments reads membership only in its two Head Coach helpers (P1-10) — never for a coach\'s own scope or the admin path', () => {
    const text = read('mentor-assignments/mentor-assignments.service.ts');
    const MEMBERSHIP = /programmeMembership|ProgrammeMembership|programmesOf|isProgrammeMember|programmeMembersFilter|programmeCoursesFilter|headedProgrammes/;
    const body = (name: string) => {
      const start = text.indexOf(`private async ${name}(`);
      expect([name, start > 0]).toEqual([name, true]);
      const next = text.indexOf('\n  /**', start);
      return text.slice(start, next > start ? next : undefined);
    };
    const helpers = [body('callerFilter'), body('assertHeadCoachMayAssign')];
    for (const h of helpers) expect(h).toMatch(MEMBERSHIP);
    let rest = text;
    for (const h of helpers) rest = rest.replace(h, '');
    expect(rest).not.toMatch(MEMBERSHIP);
    // The coach's own teaching scopes stay MentorAssignment-only.
    expect(text.slice(text.indexOf('async findMine('))).not.toMatch(MEMBERSHIP);
  });

  it('AccessService reads membership only in its programme scope helpers, after all student/coach access methods', () => {
    const text = read('common/access/access.service.ts');
    const marker = text.indexOf('Programme scope helpers');
    expect(marker).toBeGreaterThan(0);
    const accessPart = text.slice(0, marker);
    expect(accessPart).not.toMatch(/programmeMembership/);
    for (const m of ['assertCanView', 'assertCanManage', 'assertMentorOf', 'scopeFilter', 'mentorScopes', 'isAssignedMentor', 'studentDivision']) {
      expect([m, accessPart.includes(`${m}(`)]).toEqual([m, true]);
    }
  });
});
