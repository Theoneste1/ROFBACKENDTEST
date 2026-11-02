import { DIVISION_GRADES, divisionCodeForGrade, nextGrade } from './grade-levels.js';
import type { GradeLevel } from '../generated/prisma/client.js';

describe('grade levels', () => {
  it('splits S1–S3 into JUNIOR and S4–S6 into SENIOR', () => {
    expect(DIVISION_GRADES).toEqual({ JUNIOR: ['S1', 'S2', 'S3'], SENIOR: ['S4', 'S5', 'S6'] });
  });

  it.each([
    ['S1', 'JUNIOR'], ['S2', 'JUNIOR'], ['S3', 'JUNIOR'],
    ['S4', 'SENIOR'], ['S5', 'SENIOR'], ['S6', 'SENIOR'],
  ] as [GradeLevel, string][])('divisionCodeForGrade(%s) → %s', (grade, code) => {
    expect(divisionCodeForGrade(grade)).toBe(code);
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
