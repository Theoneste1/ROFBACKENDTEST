/**
 * Ending a coach's question work when they may no longer mark it (design Rev 5.2 §6, addendum 5.2 §3): removal from a
 * question, revocation of their subject authorisation, a programme MARKING restriction, or (the sweep) any other loss.
 * The caller already holds L1 for every coach in `coachIds` and has written the authorisation rows ("L1-auth"); this
 * finds the affected tasks WITHOUT locks, then locks their papers (L2, NO KEY UPDATE, ascending) and tasks (L3,
 * ascending), takes $t, and rechecks each task on its locked row:
 *   - an open claim of the coach → ends AUTHORISATION_LOST; a pool task returns to NOT_STARTED (draft ABANDONED); a
 *     resumed returned task becomes RETURNED "needs reassignment" (never back to the pool);
 *   - returned work reserved for the coach → unreserved, "needs reassignment";
 * then projects the papers. Submitted, approved and decided work is never touched.
 */
import { endCurrentClaim, lockPapers, lockTasks, lockedNow, projectPapers, taskEvent, type Actor, type Tx } from './question-store.js';

export async function withdrawQuestionWork(
  tx: Tx, coachIds: readonly string[], scope: { questionIds?: readonly string[]; disciplineId?: string; onlyIfUnauthorised?: boolean },
  actor: Actor | null, reason: string,
): Promise<number> {
  if (coachIds.length === 0) return 0;
  const questionIds = scope.questionIds ? [...scope.questionIds] : null;
  const candidates = await tx.$queryRaw<Array<{ id: string; submissionId: string }>>`
    SELECT t."id", t."submissionId" FROM "TestQuestionTask" t
      JOIN "TestQuestion" q ON q."id" = t."questionId" JOIN "Test" te ON te."id" = q."testId"
     WHERE ((t."status" = 'IN_PROGRESS' AND t."holderId" = ANY(${[...coachIds]}::text[]))
         OR (t."status" IN ('RETURNED', 'IN_PROGRESS') AND t."reservedForId" = ANY(${[...coachIds]}::text[])))
       AND (${questionIds}::text[] IS NULL OR t."questionId" = ANY(${questionIds}::text[]))
       AND (${scope.disciplineId ?? null}::text IS NULL OR te."disciplineId" = ${scope.disciplineId ?? null})`;
  if (candidates.length === 0) return 0;
  await lockPapers(tx, candidates.map((c) => c.submissionId), 'NO KEY UPDATE');
  const tasks = await lockTasks(tx, candidates.map((c) => c.id));
  const t = await lockedNow(tx);
  const touched = new Set<string>();
  let n = 0;
  for (const task of [...tasks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    const coach = task.holderId && coachIds.includes(task.holderId) ? task.holderId : task.reservedForId && coachIds.includes(task.reservedForId) ? task.reservedForId : null;
    if (!coach) continue;
    if (scope.onlyIfUnauthorised) {
      const [r] = await tx.$queryRaw<Array<{ ok: boolean }>>`
        SELECT (can_mark_subject(${coach}, te."disciplineId")
                AND EXISTS (SELECT 1 FROM "TestQuestionMarker" m WHERE m."questionId" = q."id" AND m."coachId" = ${coach} AND m."endedAt" IS NULL)) AS "ok"
          FROM "TestQuestion" q JOIN "Test" te ON te."id" = q."testId" WHERE q."id" = ${task.questionId}`;
      if (r.ok) continue;
    }
    if (task.status === 'IN_PROGRESS' && task.holderId === coach) {
      if (await endCurrentClaim(tx, task, t, actor, 'AUTHORISATION_LOST', { expectCoach: coach, unreserve: true, eventReason: reason })) { n++; touched.add(task.submissionId); }
    } else if (task.status === 'RETURNED' && task.reservedForId === coach) {
      await tx.testQuestionTask.update({ where: { id: task.id }, data: { reservedForId: null, needsReassignment: true, updatedAt: t } });
      await taskEvent(tx, t, actor, task.id, 'NEEDS_REASSIGNMENT', { from: 'RETURNED', to: 'RETURNED', cycle: task.cycle, reason, meta: { coachId: coach } });
      n++;
    }
  }
  await projectPapers(tx, touched, actor, t);
  return n;
}

/**
 * After a subject-level loss (marker authorisation revoked, programme MARKING restriction): when the coach may no longer
 * mark the subject, end their question-marker rows in it ("L1-auth") and their open claims / reserved returns there.
 * The caller took lockCoaches([coachId]) BEFORE writing the authorisation row (addendum 5.2 §3).
 */
export async function endQuestionWorkForSubject(tx: Tx, coachId: string, disciplineId: string, actor: Actor, reason: string): Promise<number> {
  const [r] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT can_mark_subject(${coachId}, ${disciplineId}) AS "ok"`;
  if (r.ok) return 0;
  await tx.$executeRaw`
    UPDATE "TestQuestionMarker" m SET "endedAt" = clock_timestamp(), "endedById" = ${actor.id}, "endReason" = ${reason}
      FROM "TestQuestion" q JOIN "Test" te ON te."id" = q."testId"
     WHERE m."questionId" = q."id" AND m."coachId" = ${coachId} AND m."endedAt" IS NULL AND te."disciplineId" = ${disciplineId}`;
  return withdrawQuestionWork(tx, [coachId], { disciplineId, onlyIfUnauthorised: true }, actor, reason);
}

/**
 * Every open claim and reserved return of a coach who may no longer mark them ends now (any subject, any question):
 * account suspended / archived, role changed, programme membership ended, or a refused request of that coach. The
 * caller took lockCoaches([coachId]) first (L1) — before writing the change that removed the authorisation.
 */
export async function endQuestionWorkIfUnauthorised(tx: Tx, coachId: string, actor: Actor | null, reason: string): Promise<number> {
  return withdrawQuestionWork(tx, [coachId], { onlyIfUnauthorised: true }, actor, reason);
}
