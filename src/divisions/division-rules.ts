/**
 * Administrator-managed divisions (owner 2026-11-21/22): a student's division IS their Olympiad level. It follows the
 * grade — the ACTIVE division whose `suggestedGrades` hold it (database function division_for_grade, migration
 * 20261224000000, which the User trigger student_division_from_grade applies on every write) — unless a Coach or a User
 * Manager set it by hand (`divisionManual`). These helpers give the application the same answer, inside its
 * transaction, so what it writes (an enrolment, a new account) agrees with the trigger.
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import type { GradeLevel, Prisma } from '../generated/prisma/client.js';

type Db = Prisma.TransactionClient | { $queryRaw: Prisma.TransactionClient['$queryRaw']; user: Prisma.TransactionClient['user'] };

export const GRADES: readonly GradeLevel[] = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];

const notConfigured = (grade: string) => new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'DIVISIONS_NOT_CONFIGURED',
  `No active division is suggested for ${grade}. An administrator must give that grade to a division.`);

/** The id of the active division the grade suggests; 503 DIVISIONS_NOT_CONFIGURED if none (the service prevents it). */
export async function divisionIdForGrade(db: Db, grade: GradeLevel): Promise<string> {
  const [row] = await db.$queryRaw<Array<{ id: string | null }>>`SELECT division_for_grade(${grade}::text) AS id`;
  if (!row?.id) throw notConfigured(grade);
  return row.id;
}

/** The division of this student at `grade`: theirs when set by hand, otherwise the one the grade suggests. */
export async function studentDivisionFor(db: Db, studentId: string, grade: GradeLevel): Promise<string> {
  const u = await db.user.findUnique({ where: { id: studentId }, select: { divisionManual: true, divisionId: true } });
  if (u?.divisionManual && u.divisionId) return u.divisionId;
  return divisionIdForGrade(db, grade);
}

/**
 * Every grade S1–S6 must be suggested by exactly one ACTIVE division (so every student has a division to follow).
 * Returns the problems for a candidate set of divisions (empty: valid).
 */
export function coverageProblems(divisions: ReadonlyArray<{ code: string; isActive: boolean; suggestedGrades: readonly string[] }>): string[] {
  const out: string[] = [];
  for (const g of GRADES) {
    const holders = divisions.filter((d) => d.isActive && d.suggestedGrades.includes(g)).map((d) => d.code);
    if (holders.length === 0) out.push(`${g} is suggested by no active division`);
    if (holders.length > 1) out.push(`${g} is suggested by more than one active division (${holders.join(', ')})`);
  }
  return out;
}
