/**
 * The claim transaction (design Rev 5.2 §6 + addenda 5.1 §2, 5.2 §1–§2) — self-service claim, resume of reserved
 * returned work, and staff direct assignment are ONE transaction with the same checks and the same limit:
 *   discover (no locks) → L1 every coach whose claim may end → L2 papers → L3 tasks → $t → recheck (retry ≤ 3 when the
 *   holder changed) → end own expired claims → limit at $t → target checks → end a previous claim → INSERT claim →
 *   UPDATE task → new EMPTY assessment (or the reserved RETURNED one on resume) → events → projection.
 * A refusal anywhere rolls the whole transaction back: nothing is left behind.
 */
import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../../prisma/prisma.service.js';
import { MAX_CLAIM_ATTEMPTS, qmErrors } from './question-rules.js';
import {
  RetryClaim, activeClaimCount, addMinutes, canMark, endCurrentClaim, endOwnExpired, expiredClaimsOf, lockCoaches, lockPapers,
  lockTasks, lockedNow, projectPapers, qmSettings, readTasks, taskEvent, type Actor, type TaskRow, type Tx,
} from './question-store.js';

const CLAIM_TX = { maxWait: 15_000, timeout: 30_000 } as const;

export interface ClaimRequest {
  taskId: string;
  coachId: string;
  /** CLAIM: the coach takes it (or resumes reserved returned work). ASSIGN: staff give it to `coachId` (reason required). */
  method: 'CLAIM' | 'ASSIGN';
  actor: Actor;
  reason?: string | null;
}

export interface ClaimResult {
  claimId: string; taskId: string; submissionId: string; lockExpiresAt: Date; method: 'CLAIM' | 'RESUME' | 'ASSIGN';
  resumed: boolean; previousHolder: string | null; previousEnd: 'EXPIRED' | 'REASSIGNED' | null;
}

/** Run the claim, retrying (≤ 3) when the set of coaches to lock changed between discovery and locking. */
export async function runClaim(prisma: PrismaService, req: ClaimRequest): Promise<ClaimResult> {
  let extra: string[] = [];
  for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction((tx) => claimOnce(tx, req, extra), CLAIM_TX);
    } catch (e) {
      if (e instanceof RetryClaim && attempt < MAX_CLAIM_ATTEMPTS) { extra = e.coaches; continue; }
      if (e instanceof RetryClaim) throw qmErrors.taskChanged({ reason: 'holder-changed' });
      if (isUniqueViolation(e)) throw qmErrors.taskTaken();
      throw e;
    }
  }
  throw qmErrors.taskChanged({ reason: 'holder-changed' });
}

function isUniqueViolation(e: unknown): boolean {
  const s = String((e as { code?: string; message?: string })?.code ?? '') + String((e as { message?: string })?.message ?? '');
  return s.includes('P2002') || s.includes('23505') || s.includes('TestTaskClaim_one_open') || s.includes('TestQuestionAssessment_one_open');
}

async function claimOnce(tx: Tx, req: ClaimRequest, extraCoaches: string[]): Promise<ClaimResult> {
  const { coachId, actor } = req;
  // ── Discovery (no locks; a hint only) ──────────────────────────────────────────────────────────────────────────
  const seen = (await readTasks(tx, [req.taskId])).get(req.taskId);
  if (!seen) throw qmErrors.taskNotFound();
  const ownExpired = await expiredClaimsOf(tx, coachId);
  const coaches = new Set<string>([coachId, ...extraCoaches]);
  if (seen.holderId) coaches.add(seen.holderId);

  // ── L1 → L2 → L3 → $t ──────────────────────────────────────────────────────────────────────────────────────────
  const locked = new Set(await lockCoaches(tx, coaches));
  const papers = await lockPapers(tx, [seen.submissionId, ...ownExpired.map((x) => x.submissionId)], 'NO KEY UPDATE');
  const tasks = await lockTasks(tx, [req.taskId, ...ownExpired.map((x) => x.taskId)]);
  const t = await lockedNow(tx);
  const settings = await qmSettings(tx);
  const task = tasks.get(req.taskId)!;
  const paper = papers.find((p) => p.id === task.submissionId)!;

  // Recheck: a claim we would end must belong to a coach we locked (5.2 §2).
  if (task.status === 'IN_PROGRESS' && task.holderId && task.holderId !== coachId && !locked.has(task.holderId)) {
    throw new RetryClaim([...locked, task.holderId]);
  }

  // ── Own expired claims end first, so they never count (5.1 §2) ───────────────────────────────────────────────────
  const touched = new Set<string>(await endOwnExpired(tx, coachId, tasks, t, actor));

  // ── The target ───────────────────────────────────────────────────────────────────────────────────────────────────
  const test = await tx.$queryRaw<Array<{ markingMode: string; disciplineId: string }>>`
    SELECT t."markingMode"::text AS "markingMode", t."disciplineId" FROM "TestSubmission" s JOIN "Test" t ON t."id" = s."testId" WHERE s."id" = ${task.submissionId}`;
  if (test[0]?.markingMode !== 'QUESTION') throw qmErrors.wrongMode(test[0]?.markingMode ?? 'PAPER');

  const liveHeldBy = task.status === 'IN_PROGRESS' && task.lockExpiresAt !== null && task.lockExpiresAt >= t ? task.holderId : null;
  if (liveHeldBy === coachId) {
    // Already mine: the same claim (opening a task you hold never creates another claim).
    return { claimId: task.claimId!, taskId: task.id, submissionId: task.submissionId, lockExpiresAt: task.lockExpiresAt!, method: 'CLAIM', resumed: true, previousHolder: null, previousEnd: null };
  }
  // Authorisation first: a coach who may not mark this question is told so, never whether someone holds it.
  const can = await canMark(tx, coachId, task.questionId);
  if (!can.subject) throw qmErrors.markerNotAuthorized();
  if (!can.marker) throw qmErrors.questionNotAssigned();
  if (task.round === 'SECOND' && task.firstTaskId) {
    const first = await tx.testQuestionAssessment.count({ where: { taskId: task.firstTaskId, markerId: coachId } });
    if (first > 0) throw qmErrors.firstMarkerExcluded();
  }
  const assign = req.method === 'ASSIGN';
  if (liveHeldBy && !assign) throw qmErrors.taskTaken();

  // Reserved returned work continues its own assessment for its marker, whether they resume it or staff assign it back.
  const resume = task.reservedForId === coachId && (task.status === 'RETURNED' || task.status === 'IN_PROGRESS');
  const claimable = task.status === 'NOT_STARTED' || task.status === 'IN_PROGRESS' || task.status === 'RETURNED';
  if (!claimable) throw qmErrors.taskNotAvailable(task.status);
  if (task.status === 'RETURNED' && !assign && !resume) throw qmErrors.taskNotAvailable(task.needsReassignment ? 'needs-reassignment' : 'reserved');
  if (task.reservedForId && task.reservedForId !== coachId && !assign) throw qmErrors.taskNotAvailable('reserved');
  if (task.versionId !== paper.currentVersionId) throw qmErrors.taskNotAvailable('version');
  const pendingResubmission = await tx.testResubmissionAuthorization.count({ where: { submissionId: task.submissionId, usedAt: null, cancelledAt: null } });
  if (pendingResubmission > 0) throw qmErrors.resubmissionPending();
  // The limit applies to every new claim — self-service, resume and staff assignment alike; no override (Rev 5).
  const active = await activeClaimCount(tx, coachId, t);
  if (active >= settings.maxActiveClaims) throw assign ? qmErrors.claimLimitFor(settings.maxActiveClaims) : qmErrors.claimLimit(settings.maxActiveClaims);

  // ── A previous claim on the target ends (expired, or reassigned by staff) ─────────────────────────────────────────
  let previousHolder: string | null = null;
  let previousEnd: ClaimResult['previousEnd'] = null;
  if (task.status === 'IN_PROGRESS' && task.claimId) {
    previousHolder = task.holderId;
    const expired = task.lockExpiresAt !== null && task.lockExpiresAt < t;
    previousEnd = expired ? 'EXPIRED' : 'REASSIGNED';
    const ok = await endCurrentClaim(tx, task, t, actor, previousEnd, { requireExpired: expired, unreserve: assign && task.reservedForId !== coachId, eventReason: assign ? req.reason ?? null : null });
    if (!ok) throw qmErrors.taskChanged({ reason: 'claim-changed' });
  }
  // Reassigning RETURNED work to another coach: the reserved assessment is superseded; the new coach starts empty.
  if (assign && task.status === 'RETURNED' && task.reservedForId !== coachId) {
    const old = await tx.testQuestionAssessment.findFirst({ where: { taskId: task.id, status: 'RETURNED' }, select: { id: true } });
    if (old) {
      await tx.testQuestionAssessment.update({ where: { id: old.id }, data: { status: 'SUPERSEDED', updatedAt: t } });
      await taskEvent(tx, t, actor, task.id, 'ASSESSMENT_SUPERSEDED', { meta: { assessmentId: old.id }, reason: req.reason ?? null });
    }
    previousHolder = previousHolder ?? task.reservedForId;
  }

  // ── The new claim, the task, the assessment ──────────────────────────────────────────────────────────────────────
  const claimId = randomUUID();
  const method = assign ? 'ASSIGN' : resume ? 'RESUME' : 'CLAIM';
  const lockExpiresAt = addMinutes(t, settings.lockMinutes);
  await tx.testTaskClaim.create({ data: { id: claimId, taskId: task.id, coachId, method, claimedAt: t, lastActiveAt: t } });
  const fromStatus = task.status;
  await tx.testQuestionTask.update({
    where: { id: task.id },
    data: {
      status: 'IN_PROGRESS', holderId: coachId, claimId, lockExpiresAt, updatedAt: t,
      ...(resume ? {} : { reservedForId: null, needsReassignment: false }),
    },
  });
  if (!resume) {
    // One query at a time inside the transaction (one connection).
    const q = await tx.testQuestion.findUniqueOrThrow({ where: { id: task.questionId }, select: { promptVersion: true, testId: true } });
    const guide = await tx.$queryRaw<Array<{ fileId: string }>>`SELECT f."fileId" FROM "TestFile" f JOIN "TestQuestion" q ON q."testId" = f."testId" WHERE q."id" = ${task.questionId} AND f."kind" = 'MARKING_GUIDE'`;
    await tx.testQuestionAssessment.create({
      data: { id: randomUUID(), taskId: task.id, markerId: coachId, openedByClaimId: claimId, status: 'DRAFT', guideFileId: guide[0]?.fileId ?? null, promptVersion: q.promptVersion, createdAt: t, updatedAt: t },
    });
  }
  await taskEvent(tx, t, actor, task.id, method === 'CLAIM' ? 'CLAIMED' : method === 'RESUME' ? 'RESUMED' : 'ASSIGNED', {
    from: fromStatus, to: 'IN_PROGRESS', cycle: task.cycle, reason: req.reason ?? null, meta: { claimId, coachId, previousHolder, previousEnd },
  });
  touched.add(task.submissionId);
  await projectPapers(tx, touched, actor, t);
  return { claimId, taskId: task.id, submissionId: task.submissionId, lockExpiresAt, method, resumed: resume, previousHolder, previousEnd };
}

/** The holder of the task's current open claim and that claim (unlocked; for coach-facing reads). */
export async function currentClaimOf(db: Tx, taskId: string, coachId: string): Promise<{ id: string; endedAt: Date | null; endReason: string | null } | null> {
  return db.testTaskClaim.findFirst({ where: { taskId, coachId }, orderBy: { claimedAt: 'desc' }, select: { id: true, endedAt: true, endReason: true } });
}

export type { TaskRow };
