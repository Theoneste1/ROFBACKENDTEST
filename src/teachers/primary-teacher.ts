/**
 * Primary teacher of a school (owner decision 2026-11-19). The primary teacher is the school's designated MAIN
 * CONTACT only: primary and secondary teachers have exactly the same rights (no permission, account state or access
 * depends on the role).
 *
 * Rules:
 *   - the first teacher linked to a school by an Administrator (an approved application or a direct assignment)
 *     becomes PRIMARY when the school has no active primary and the account is ACTIVE; every later one is SECONDARY;
 *   - an Administrator (users.manageTeachers) reassigns: the chosen teacher becomes PRIMARY and the previous one
 *     SECONDARY, in one transaction, audited (TEACHER_PRIMARY_ASSIGNED);
 *   - when the primary's link ends (an Administrator, a role change) or the account leaves ACTIVE (deactivated,
 *     suspended, archived), the link becomes SECONDARY and the school has NO primary: nobody is promoted
 *     automatically, an Administrator chooses the next one. A reactivated account stays SECONDARY.
 *
 * At most one ACTIVE PRIMARY per school is a DATABASE guarantee: the partial unique index
 * TeacherSchoolAssignment_one_primary_per_school (migration 20261212000000). Every decision first takes a
 * transaction-scoped advisory lock per school (PRIMARY_LOCK_NAMESPACE, hashtext(schoolId)), so concurrent approvals
 * of the same school are serialised: the second sees the first's committed primary and becomes SECONDARY instead of
 * failing on the index.
 */
import type { AuditService } from '../audit/audit.service.js';
import type { Prisma, TeacherSchoolRole } from '../generated/prisma/client.js';

/** pg advisory lock namespace of primary-teacher decisions (key: hashtext(schoolId)). */
export const PRIMARY_LOCK_NAMESPACE = 4219;

/** Serialise primary-teacher decisions of these schools until the transaction ends (ascending id: no deadlock). */
export async function lockSchoolPrimary(tx: Prisma.TransactionClient, schoolIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(schoolIds)].sort()) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${PRIMARY_LOCK_NAMESPACE}::int, hashtext(${id}))::text`;
  }
}

/**
 * The teacher's account state, its row share-locked until the transaction ends: an account-state change (which takes
 * the row FOR NO KEY UPDATE, then the school locks) waits for this decision, or this waits for it — always the account
 * row first, then the school lock, so the two never wait for each other in opposite orders.
 */
export async function lockTeacherAccount(tx: Prisma.TransactionClient, teacherId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<Array<{ accountStatus: string }>>`SELECT "accountStatus"::text AS "accountStatus" FROM "User" WHERE "id" = ${teacherId} FOR SHARE`;
  return row?.accountStatus ?? null;
}

/**
 * The role of a link an Administrator creates or re-activates now (caller holds lockTeacherAccount, then
 * lockSchoolPrimary for the school): PRIMARY only when the school has no active primary and the account is ACTIVE.
 */
export async function roleForNewLink(tx: Prisma.TransactionClient, schoolId: string, accountStatus: string | null): Promise<TeacherSchoolRole> {
  if (accountStatus !== 'ACTIVE') return 'SECONDARY';
  const primary = await tx.teacherSchoolAssignment.count({ where: { schoolId, isActive: true, role: 'PRIMARY' } });
  return primary === 0 ? 'PRIMARY' : 'SECONDARY';
}

/**
 * A teacher's account left ACTIVE: each school where they were the primary is left WITHOUT one (their links become
 * SECONDARY; nobody is promoted). One TEACHER_PRIMARY_CLEARED audit row per school, in the caller's transaction.
 */
export async function clearPrimaryOfAccount(
  tx: Prisma.TransactionClient, audit: AuditService, teacherId: string,
  actor: { actorId: string; actorRole: string }, context: { reason: string; [k: string]: unknown },
): Promise<void> {
  // Lock every school the teacher is linked to first, then read: a reassignment to this teacher committed meanwhile is
  // seen (and cleared); one that starts after this commits sees the account is no longer ACTIVE and is refused.
  const schools = await tx.teacherSchoolAssignment.findMany({ where: { teacherId, isActive: true }, select: { schoolId: true } });
  if (schools.length === 0) return;
  await lockSchoolPrimary(tx, schools.map((s) => s.schoolId));
  const links = await tx.teacherSchoolAssignment.findMany({ where: { teacherId, role: 'PRIMARY' }, select: { id: true, schoolId: true } });
  if (links.length === 0) return;
  await tx.teacherSchoolAssignment.updateMany({ where: { id: { in: links.map((l) => l.id) }, role: 'PRIMARY' }, data: { role: 'SECONDARY' } });
  for (const l of links) {
    await audit.log({
      ...actor, action: 'TEACHER_PRIMARY_CLEARED', entity: 'TeacherSchoolAssignment', entityId: l.id,
      metadata: { teacherId, schoolId: l.schoolId, ...context },
    }, tx);
  }
}
