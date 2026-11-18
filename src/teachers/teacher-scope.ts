/**
 * Which students a Teacher sees, and which of them a delegation covers (owner approvals TS-1…TS-6, 2026-11-18).
 *
 *  Visible = approved, activated STUDENT accounts that are
 *    (a) verified students of one of the teacher's ACTIVE schools (TS-1: an Administrator-verified current claim —
 *        e-mail verification never establishes school membership), or
 *    (b) explicitly assigned to the teacher by an Administrator (an ACTIVE TeacherStudentAssignment; TS-2 several
 *        teachers per student; TS-3 another school's student only with a reason). An assignment gives that student
 *        only — never the rest of their school.
 *  Pending students of the teacher's schools are never identified to the teacher: only their number is shown.
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

/** Approved, activated students explicitly assigned to the teacher (active assignment). */
export function assignedStudentsWhere(teacherId: string): Prisma.UserWhereInput {
  return { role: 'STUDENT', isApproved: true, activatedAt: { not: null }, teacherStudentsAsStudent: { some: { teacherId, isActive: true } } };
}

/** Every student the teacher sees: (a) ∪ (b). */
export function teacherStudentsWhere(teacherId: string, schoolIds: readonly string[]): Prisma.UserWhereInput {
  return { OR: [schoolStudentsWhere(schoolIds), assignedStudentsWhere(teacherId)] };
}

export async function activeSchoolsOf(db: Db, teacherId: string): Promise<string[]> {
  const rows = await db.teacherSchoolAssignment.findMany({ where: { teacherId, isActive: true }, select: { schoolId: true }, orderBy: { schoolId: 'asc' } });
  return rows.map((r) => r.schoolId);
}

/** How each of these students is visible to the teacher (absent from the map = not visible). */
export async function visibilityOf(db: Db, teacherId: string, schoolIds: readonly string[], studentIds: readonly string[]) {
  const ids = [...new Set(studentIds)];
  const out = new Map<string, { viaSchool: boolean; viaAssignment: boolean }>();
  if (ids.length === 0) return out;
  const [bySchool, byAssignment] = await Promise.all([
    db.user.findMany({ where: { id: { in: ids }, ...schoolStudentsWhere(schoolIds) }, select: { id: true } }),
    db.user.findMany({ where: { id: { in: ids }, ...assignedStudentsWhere(teacherId) }, select: { id: true } }),
  ]);
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
