import { nextGrade } from './grade-levels.js';
import { coverageProblems } from '../divisions/division-rules.js';
import type { GradeLevel } from '../generated/prisma/client.js';

describe('grade levels', () => {
  it('divisions (administrator-managed): every grade S1–S6 is suggested by exactly one ACTIVE division', () => {
    const seed = [
      { code: 'JUNIOR', isActive: true, suggestedGrades: ['S1', 'S2', 'S3'] },
      { code: 'MIDDLE', isActive: true, suggestedGrades: [] },
      { code: 'SENIOR', isActive: true, suggestedGrades: ['S4', 'S5', 'S6'] },
    ];
    expect(coverageProblems(seed)).toEqual([]);
    // Middle takes S3–S4 from the others: still valid.
    expect(coverageProblems([
      { code: 'JUNIOR', isActive: true, suggestedGrades: ['S1', 'S2'] }, { code: 'MIDDLE', isActive: true, suggestedGrades: ['S3', 'S4'] },
      { code: 'SENIOR', isActive: true, suggestedGrades: ['S5', 'S6'] },
    ])).toEqual([]);
    // A grade nobody holds, a grade held twice, an inactive holder: refused, each named.
    expect(coverageProblems([{ code: 'JUNIOR', isActive: true, suggestedGrades: ['S1', 'S2', 'S3'] }, { code: 'SENIOR', isActive: true, suggestedGrades: ['S3', 'S4', 'S5'] }]))
      .toEqual(['S3 is suggested by more than one active division (JUNIOR, SENIOR)', 'S6 is suggested by no active division']);
    expect(coverageProblems([...seed.slice(0, 2), { code: 'SENIOR', isActive: false, suggestedGrades: ['S4', 'S5', 'S6'] }]))
      .toEqual(['S4 is suggested by no active division', 'S5 is suggested by no active division', 'S6 is suggested by no active division']);
  });

  it.each([
    ['S1', 'S2'], ['S2', 'S3'], ['S3', 'S4'], ['S4', 'S5'], ['S5', 'S6'],
  ] as [GradeLevel, GradeLevel][])('nextGrade(%s) → %s', (grade, next) => {
    expect(nextGrade(grade)).toBe(next);
  });

  it('nextGrade(S6) is null (the student graduates)', () => {
    expect(nextGrade('S6')).toBeNull();
  });

  it('nextGrade of an unknown grade is null', () => {
    expect(nextGrade('S9' as GradeLevel)).toBeNull();
  });
});
