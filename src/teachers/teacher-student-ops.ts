/**
 * Teacher–student assignments and selected-student delegations: the changes themselves, written INSIDE the caller's
 * transaction with their audit rows (both happen or neither). Used by the Administrator routes (one request = one
 * transaction) and by the bulk worker (one item = one transaction). Owner approvals TS-1…TS-6 (2026-11-18).
 *
 * Every function returns an outcome instead of throwing for an ordinary refusal (a student who is not a student, an
 * assignment already active…), so one request can process many students and report each one; nothing here ever
 * aborts the surrounding transaction with a database error (duplicates use ON CONFLICT DO NOTHING).
 */
import type { AuditService } from '../audit/audit.service.js';
import { TEACHER_DELEGATIONS } from '../auth/override-policy.js';
import type { Prisma } from '../generated/prisma/client.js';
import { activeSchoolsOf, visibilityOf } from './teacher-scope.js';

type Tx = Prisma.TransactionClient;
export interface Actor { actorId: string; actorRole: string }

export type ItemOutcome = 'ASSIGNED' | 'REACTIVATED' | 'ENDED' | 'ADDED' | 'REMOVED' | 'SKIPPED' | 'FAILED';
export interface ItemResult { studentId: string; outcome: ItemOutcome; code?: string; message?: string; id?: string }

/** Minimum length of the reason for assigning a student outside the teacher's verified schools (TS-3). */
export const CROSS_SCHOOL_REASON_MIN = 5;

/** Namespace of the per-teacher advisory lock taken while creating overrides (same as PermissionOverridesService). */
export const OVERRIDE_LOCK_NAMESPACE = 4209;

const skipped = (studentId: string, code: string, message?: string): ItemResult => ({ studentId, outcome: 'SKIPPED', code, ...(message && { message }) });
const failed = (studentId: string, code: string, message: string): ItemResult => ({ studentId, outcome: 'FAILED', code, message });

/**
 * Assign one student to a teacher (or re-activate an ended assignment — one row per pair, so no duplicates and the
 * history stays). The teacher has already been checked to be a TEACHER. A student who is not a verified student of
 * one of the teacher's active schools is a cross-school assignment and needs a reason (TS-3).
 */
export async function assignStudentInTx(
  tx: Tx, audit: AuditService,
  a: { teacherId: string; studentId: string; actor: Actor; source: 'ADMIN' | 'BULK'; reason?: string | null; operationId?: string; reassignedFrom?: string },
): Promise<ItemResult> {
  const { teacherId, studentId } = a;
  const student = await tx.user.findUnique({ where: { id: studentId }, select: { id: true, role: true } });
  if (!student) return failed(studentId, 'NOT_FOUND', 'The account does not exist.');
  if (student.role !== 'STUDENT') return failed(studentId, 'NOT_A_STUDENT', 'Only Student accounts can be assigned to a teacher.');

  const schools = await activeSchoolsOf(tx, teacherId);
  const crossSchool = !(await visibilityOf(tx, teacherId, schools, [studentId])).get(studentId)?.viaSchool;
  const reason = a.reason?.trim() || null;
  if (crossSchool && (!reason || reason.length < CROSS_SCHOOL_REASON_MIN)) {
    return failed(studentId, 'REASON_REQUIRED',
      'This student is not a verified student of the teacher\'s schools: give a reason (at least 5 characters) to assign them.');
  }

  const existing = await tx.teacherStudentAssignment.findUnique({
    where: { teacherId_studentId: { teacherId, studentId } }, select: { id: true, isActive: true },
  });
  if (existing?.isActive) return skipped(studentId, 'ALREADY_ASSIGNED', 'This student is already assigned to this teacher.');

  let id: string;
  if (existing) {
    // Conditional: a concurrent re-activation updates nothing here.
    const { count } = await tx.teacherStudentAssignment.updateMany({
      where: { id: existing.id, isActive: false },
      data:  { isActive: true, endedAt: null, endedById: null, endReason: null, assignedById: a.actor.actorId, source: a.source, crossSchool, reason },
    });
    if (count === 0) return skipped(studentId, 'ALREADY_ASSIGNED', 'This student is already assigned to this teacher.');
    id = existing.id;
  } else {
    const created = await tx.teacherStudentAssignment.createManyAndReturn({
      data: [{ teacherId, studentId, source: a.source, crossSchool, reason, assignedById: a.actor.actorId }],
      skipDuplicates: true, select: { id: true },
    });
    if (created.length === 0) return skipped(studentId, 'ALREADY_ASSIGNED', 'This student is already assigned to this teacher.');
    id = created[0].id;
  }
  await audit.log({
    ...a.actor, action: 'TEACHER_STUDENT_ASSIGNED', entity: 'TeacherStudentAssignment', entityId: id,
    metadata: {
      teacherId, studentId, source: a.source, crossSchool, reason, reactivated: !!existing,
      from: existing ? 'ENDED' : null, to: 'ACTIVE',
      ...(a.operationId && { operationId: a.operationId }), ...(a.reassignedFrom && { reassignedFrom: a.reassignedFrom }),
    },
  }, tx);
  return { studentId, outcome: existing ? 'REACTIVATED' : 'ASSIGNED', id };
}

/**
 * End an ACTIVE assignment (kept as history). Then TS-5: if the teacher no longer sees the student at all, the
 * student is taken off every SELECTED delegation of that teacher (row kept, removeReason ASSIGNMENT_ENDED) and each
 * such delegation is flagged for an Administrator's review. Nothing is deleted.
 */
export async function endAssignmentInTx(
  tx: Tx, audit: AuditService,
  a: { where: { id: string } | { teacherId: string; studentId: string }; actor: Actor; reason: string; operationId?: string },
): Promise<ItemResult & { teacherId?: string }> {
  const row = await tx.teacherStudentAssignment.findFirst({
    where: 'id' in a.where ? { id: a.where.id } : { teacherId: a.where.teacherId, studentId: a.where.studentId },
    select: { id: true, teacherId: true, studentId: true, isActive: true },
  });
  const sid = row?.studentId ?? ('studentId' in a.where ? a.where.studentId : '');
  if (!row) return failed(sid, 'NOT_ASSIGNED', 'This student is not assigned to this teacher.');
  const { count } = await tx.teacherStudentAssignment.updateMany({
    where: { id: row.id, isActive: true }, data: { isActive: false, endedAt: new Date(), endedById: a.actor.actorId, endReason: a.reason },
  });
  if (count === 0) return skipped(row.studentId, 'ASSIGNMENT_ENDED', 'This assignment has already ended.');
  await audit.log({
    ...a.actor, action: 'TEACHER_STUDENT_UNASSIGNED', entity: 'TeacherStudentAssignment', entityId: row.id,
    metadata: { teacherId: row.teacherId, studentId: row.studentId, reason: a.reason, from: 'ACTIVE', to: 'ENDED', ...(a.operationId && { operationId: a.operationId }) },
  }, tx);
  await dropSelectionsOutOfScope(tx, audit, row.teacherId, row.studentId, a.actor);
  return { studentId: row.studentId, outcome: 'ENDED', id: row.id, teacherId: row.teacherId };
}

/** TS-5 (see endAssignmentInTx). Also used when a role change ends assignments. */
export async function dropSelectionsOutOfScope(tx: Tx, audit: AuditService, teacherId: string, studentId: string, actor: Actor) {
  const schools = await activeSchoolsOf(tx, teacherId);
  if ((await visibilityOf(tx, teacherId, schools, [studentId])).has(studentId)) return;
  const rows = await tx.userPermissionOverrideStudent.findMany({
    where: { studentId, removedAt: null, override: { userId: teacherId, revokedAt: null } },
    select: { id: true, overrideId: true, override: { select: { permission: true } } },
  });
  const now = new Date();
  for (const r of rows) {
    await tx.userPermissionOverrideStudent.updateMany({
      where: { id: r.id, removedAt: null }, data: { removedAt: now, removedById: actor.actorId, removeReason: 'ASSIGNMENT_ENDED' },
    });
    await tx.userPermissionOverride.update({
      where: { id: r.overrideId }, data: { reviewNeededAt: now, reviewReason: 'STUDENT_LEFT_SCOPE' },
    });
    await audit.log({
      ...actor, action: 'DELEGATION_STUDENT_REMOVED', entity: 'UserPermissionOverride', entityId: r.overrideId,
      metadata: { teacherId, studentId, permission: r.override.permission, reason: 'ASSIGNMENT_ENDED', reviewNeeded: true, from: 'SELECTED', to: 'REMOVED' },
    }, tx);
  }
}

/** Role change: every active assignment of this user, as teacher or as student, ends (reason ROLE_CHANGE). */
export async function endAssignmentsOfUser(tx: Tx, audit: AuditService, userId: string, actor: Actor) {
  const active = await tx.teacherStudentAssignment.findMany({
    where: { isActive: true, OR: [{ teacherId: userId }, { studentId: userId }] }, select: { id: true }, orderBy: { id: 'asc' },
  });
  for (const a of active) await endAssignmentInTx(tx, audit, { where: { id: a.id }, actor, reason: 'ROLE_CHANGE' });
}

/**
 * Put one student on a SELECTED delegation (or back on it). The student must be visible to the teacher now.
 */
export async function addSelectionInTx(
  tx: Tx, audit: AuditService,
  a: { override: { id: string; userId: string; permission: string }; studentId: string; actor: Actor; operationId?: string },
): Promise<ItemResult> {
  const { override, studentId } = a;
  const schools = await activeSchoolsOf(tx, override.userId);
  if (!(await visibilityOf(tx, override.userId, schools, [studentId])).has(studentId)) {
    return failed(studentId, 'STUDENT_NOT_IN_TEACHER_SCOPE', 'The teacher does not see this student (not a verified student of their schools, and not assigned to them).');
  }
  const existing = await tx.userPermissionOverrideStudent.findUnique({
    where: { overrideId_studentId: { overrideId: override.id, studentId } }, select: { id: true, removedAt: true },
  });
  if (existing && existing.removedAt === null) return skipped(studentId, 'ALREADY_SET', 'This student is already covered by this delegation.');
  if (existing) {
    const { count } = await tx.userPermissionOverrideStudent.updateMany({
      where: { id: existing.id, removedAt: { not: null } },
      data:  { removedAt: null, removedById: null, removeReason: null, addedById: a.actor.actorId },
    });
    if (count === 0) return skipped(studentId, 'ALREADY_SET', 'This student is already covered by this delegation.');
  } else {
    const created = await tx.userPermissionOverrideStudent.createManyAndReturn({
      data: [{ overrideId: override.id, studentId, addedById: a.actor.actorId }], skipDuplicates: true, select: { id: true },
    });
    if (created.length === 0) return skipped(studentId, 'ALREADY_SET', 'This student is already covered by this delegation.');
  }
  await audit.log({
    ...a.actor, action: 'DELEGATION_STUDENT_ADDED', entity: 'UserPermissionOverride', entityId: override.id,
    metadata: {
      teacherId: override.userId, studentId, permission: override.permission, readded: !!existing,
      from: existing ? 'REMOVED' : null, to: 'SELECTED', ...(a.operationId && { operationId: a.operationId }),
    },
  }, tx);
  return { studentId, outcome: 'ADDED', id: override.id };
}

/** Take one student off a SELECTED delegation (row kept). */
export async function removeSelectionInTx(
  tx: Tx, audit: AuditService,
  a: { override: { id: string; userId: string; permission: string }; studentId: string; actor: Actor; operationId?: string },
): Promise<ItemResult> {
  const { count } = await tx.userPermissionOverrideStudent.updateMany({
    where: { overrideId: a.override.id, studentId: a.studentId, removedAt: null },
    data:  { removedAt: new Date(), removedById: a.actor.actorId, removeReason: 'ADMIN' },
  });
  if (count === 0) return skipped(a.studentId, 'NOT_APPLICABLE', 'This student is not covered by this delegation.');
  await audit.log({
    ...a.actor, action: 'DELEGATION_STUDENT_REMOVED', entity: 'UserPermissionOverride', entityId: a.override.id,
    metadata: {
      teacherId: a.override.userId, studentId: a.studentId, permission: a.override.permission, reason: 'ADMIN',
      from: 'SELECTED', to: 'REMOVED', ...(a.operationId && { operationId: a.operationId }),
    },
  }, tx);
  return { studentId: a.studentId, outcome: 'REMOVED', id: a.override.id };
}

/** The teacher's ACTIVE SELECTED delegation of this permission, or null. */
export async function activeSelectedOverride(tx: Tx, teacherId: string, permission: string) {
  return tx.userPermissionOverride.findFirst({
    where: {
      userId: teacherId, permission, effect: 'GRANT', studentScope: 'SELECTED', revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { id: true, userId: true, permission: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * The teacher's SELECTED delegation of this permission, created (with its audit row) when there is none — under the
 * same per-teacher advisory lock as every override creation, so two concurrent items never create two.
 * Returns the override and whether it was created now.
 */
export async function ensureSelectedOverrideInTx(
  tx: Tx, audit: AuditService,
  a: { teacher: { id: string; role: string }; permission: string; reason: string; actor: Actor; operationId?: string },
) {
  if (!(TEACHER_DELEGATIONS as readonly string[]).includes(a.permission)) throw new Error(`${a.permission} is not a teacher delegation`);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${OVERRIDE_LOCK_NAMESPACE}::int, hashtext(${a.teacher.id}))::text`;
  const found = await activeSelectedOverride(tx, a.teacher.id, a.permission);
  if (found) return { override: found, created: false };
  const created = await tx.userPermissionOverride.create({
    data: {
      userId: a.teacher.id, permission: a.permission, effect: 'GRANT', studentScope: 'SELECTED', reason: a.reason, createdById: a.actor.actorId,
    },
    select: { id: true, userId: true, permission: true },
  });
  await audit.log({
    ...a.actor, action: 'PERMISSION_OVERRIDE_CREATE', entity: 'UserPermissionOverride', entityId: created.id,
    metadata: {
      targetUserId: a.teacher.id, targetRole: a.teacher.role, permission: a.permission, effect: 'GRANT', scope: 'SCHOOL', studentScope: 'SELECTED',
      reason: a.reason, expiresAt: null, previous: null, next: { active: true }, via: 'TEACHER_DELEGATION',
      ...(a.operationId && { operationId: a.operationId }),
    },
  }, tx);
  return { override: created, created: true };
}

/** Counts of a result list (for the response). */
export function countOutcomes(results: readonly ItemResult[]) {
  const out: Partial<Record<ItemOutcome, number>> = {};
  for (const r of results) out[r.outcome] = (out[r.outcome] ?? 0) + 1;
  return out;
}
