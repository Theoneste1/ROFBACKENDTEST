import type { GradeLevel } from '../generated/prisma/client.js';

// The grade → division mapping is no longer fixed here (owner 2026-11-21/22): Administrators set each division's
// suggested grades (src/divisions/division-rules.ts, database function division_for_grade).

/** The next grade up, or null after S6 (the student graduates). */
export function nextGrade(grade: GradeLevel): GradeLevel | null {
  const order: GradeLevel[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
  const i = order.indexOf(grade);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}
