/**
 * Which students a Teacher sees, and which of them a delegation covers (owner approvals TS-1…TS-6, 2026-11-18).
 *
 *  Visible = approved, activated STUDENT accounts that are
 *    (a) students of one of the teacher's ACTIVE schools: the student's current claim names that school and is PENDING
 *        or VERIFIED (owner, 2026-11-21: automatic discovery by school code — no Administrator step; a REJECTED or
 *        REVOKED claim never counts; access.service.ts SCHOOL_MEMBER_CLAIMS), or
 *    (b) explicitly assigned to the teacher by an Administrator (an ACTIVE TeacherStudentAssignment; TS-2 several
 *        teachers per student; TS-3 another school's student only with a reason). An assignment gives that student
 *        only — never the rest of their school. An assignment made WITHOUT a reason (crossSchool = false: the student
 *        was then a student of the teacher's schools) counts only while that is still true — if the student
 *        moves school, loses the verified claim, or the teacher's school assignment ends, it gives nothing, so it can
 *        never become a cross-school assignment without a reason (TS-3). An Administrator re-assigns with a reason.
 *  Only ACTIVE accounts are visible (SR-1, owner approval 2026-11-18): a SUSPENDED, DEACTIVATED or ARCHIVED student is
 *  hidden from the teacher on every path — list, summary, profile, progress, delegations and submit on behalf — whether
 *  through the school or through an assignment, cross-school included. Hiding is not leaving scope: the assignment and
 *  the delegation's selected students stay, and apply again if an Administrator reactivates the account.
 *
 *  A delegation (students.viewProfile, students.viewProgress, submissions.submitOnBehalf) covers a visible student
 *  when its studentScope is
 *    SCHOOL   — the student is visible through (a);
 *    ASSIGNED — the student is visible through (b);
 *    SELECTED — the student is listed on the delegation (an active UserPermissionOverrideStudent row).
 *  Everything is read fresh on each request: ending an assignment or revoking a delegation applies at once.
 */
import type { Prisma } from '../generated/prisma/client.js';
import { schoolStudentsWhere } from '../common/access/access.service.js';

export type StudentScope = 'SCHOOL' | 'ASSIGNED' | 'SELECTED';
export const STUDENT_SCOPES: readonly StudentScope[] = ['SCHOOL', 'ASSIGNED', 'SELECTED'];

type Db = Pick<Prisma.TransactionClient, 'teacherSchoolAssignment' | 'user' | 'teacherStudentAssignment' | 'userPermissionOverride'>;

/** SR-1: the student's account is ACTIVE (pending verification / approval are excluded by the conditions above). */
export const ACTIVE_ACCOUNT: Prisma.UserWhereInput = { accountStatus: 'ACTIVE' };

/**
 * Scope, not visibility: approved, activated students explicitly assigned to the teacher (active assignment): a cross-school assignment (made
 * with a reason) always; a same-school one only while the student is still a student of the teacher's schools (rule (a)).
 */
export function assignedStudentsWhere(teacherId: string, schoolIds: readonly string[]): Prisma.UserWhereInput {
  return {
    OR: [
      { role: 'STUDENT', isApproved: true, activatedAt: { not: null }, teacherStudentsAsStudent: { some: { teacherId, isActive: true, crossSchool: true } } },
      { AND: [schoolStudentsWhere(schoolIds), { teacherStudentsAsStudent: { some: { teacherId, isActive: true, crossSchool: false } } }] },
    ],
  };
}

/** Students the teacher SEES through (a): students of their schools (current PENDING or VERIFIED claim) whose account is ACTIVE. */
export function visibleSchoolStudentsWhere(schoolIds: readonly string[]): Prisma.UserWhereInput {
  return { AND: [schoolStudentsWhere(schoolIds), ACTIVE_ACCOUNT] };
}

/** Students the teacher SEES through (b): assigned students whose account is ACTIVE. */
export function visibleAssignedStudentsWhere(teacherId: string, schoolIds: readonly string[]): Prisma.UserWhereInput {
  return { AND: [assignedStudentsWhere(teacherId, schoolIds), ACTIVE_ACCOUNT] };
}

/** Every student the teacher sees: ((a) ∪ (b)) and ACTIVE. */
export function teacherStudentsWhere(teacherId: string, schoolIds: readonly string[]): Prisma.UserWhereInput {
  return { AND: [{ OR: [schoolStudentsWhere(schoolIds), assignedStudentsWhere(teacherId, schoolIds)] }, ACTIVE_ACCOUNT] };
}

export async function activeSchoolsOf(db: Db, teacherId: string): Promise<string[]> {
  const rows = await db.teacherSchoolAssignment.findMany({ where: { teacherId, isActive: true }, select: { schoolId: true }, orderBy: { schoolId: 'asc' } });
  return rows.map((r) => r.schoolId);
}

/**
 * How each of these students is visible to the teacher (absent from the map = not visible). `scope` ignores the account
 * state (SR-1): it answers "is the student within the teacher's scope", used to classify an assignment as cross-school
 * and to drop selections of students who LEFT scope — a suspension must change neither.
 */
export async function visibilityOf(
  db: Db, teacherId: string, schoolIds: readonly string[], studentIds: readonly string[], mode: 'visible' | 'scope' = 'visible',
) {
  const ids = [...new Set(studentIds)];
  const out = new Map<string, { viaSchool: boolean; viaAssignment: boolean }>();
  if (ids.length === 0) return out;
  // One after the other: `db` is often a transaction client, which must not run two queries at once.
  const bySchool = await db.user.findMany({ where: { AND: [{ id: { in: ids } }, mode === 'visible' ? visibleSchoolStudentsWhere(schoolIds) : schoolStudentsWhere(schoolIds)] }, select: { id: true } });
  const byAssignment = await db.user.findMany({ where: { AND: [{ id: { in: ids } }, mode === 'visible' ? visibleAssignedStudentsWhere(teacherId, schoolIds) : assignedStudentsWhere(teacherId, schoolIds)] }, select: { id: true } });
  for (const { id } of bySchool) out.set(id, { viaSchool: true, viaAssignment: false });
  for (const { id } of byAssignment) out.set(id, { viaSchool: out.get(id)?.viaSchool ?? false, viaAssignment: true });
  return out;
}

export interface DelegationGrant { id: string; permission: string; studentScope: StudentScope | null; selected: readonly string[] }

/** The teacher's ACTIVE delegation grants (not revoked, not expired), with the students listed on SELECTED ones. */
export async function activeGrantsOf(db: Db, teacherId: string, permissions: readonly string[], now = new Date()): Promise<DelegationGrant[]> {
  const rows = await db.userPermissionOverride.findMany({
    where: {
      userId: teacherId, effect: 'GRANT', permission: { in: [...permissions] }, revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { id: true, permission: true, studentScope: true, students: { where: { removedAt: null }, select: { studentId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ id: r.id, permission: r.permission, studentScope: r.studentScope, selected: r.students.map((s) => s.studentId) }));
}

/**
 * Pure: does one of these grants (of one permission) cover this visible student? A grant without a scope (written
 * before student scopes existed) counts as SCHOOL — its behaviour then.
 */
export function delegationCovers(
  grants: ReadonlyArray<Pick<DelegationGrant, 'studentScope' | 'selected'>>,
  student: { id: string; viaSchool: boolean; viaAssignment: boolean },
): boolean {
  if (!student.viaSchool && !student.viaAssignment) return false;
  return grants.some((g) => {
    switch (g.studentScope ?? 'SCHOOL') {
      case 'SCHOOL':   return student.viaSchool;
      case 'ASSIGNED': return student.viaAssignment;
      case 'SELECTED': return g.selected.includes(student.id);
      default:         return false;
    }
  });
}
