import { DivisionCode, GradeLevel } from '../generated/prisma/client.js';

/** Junior: S1–S3. Senior: S4–S6. */
export const DIVISION_GRADES: Record<DivisionCode, GradeLevel[]> = {
  JUNIOR: ['S1', 'S2', 'S3'],
  SENIOR: ['S4', 'S5', 'S6'],
};

export function divisionCodeForGrade(grade: GradeLevel): DivisionCode {
  return DIVISION_GRADES.JUNIOR.includes(grade) ? 'JUNIOR' : 'SENIOR';
}

/** The next grade up, or null after S6 (the student graduates). */
export function nextGrade(grade: GradeLevel): GradeLevel | null {
  const order: GradeLevel[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  const i = order.indexOf(grade);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}
