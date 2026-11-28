/**
 * Question-level marking — the database steps (design Rev 5.2 §6, addenda 5.1 and 5.2). Every function runs inside the
 * caller's transaction and follows the ONE lock order:
 *   L0 Test row (only generation and mode/structure changes) →
 *   L1 coach advisory locks (every coach whose claims may open or end; ascending id; ONE statement each) →
 *      L1-auth (authorisation rows of that coach) →
 *   L2 papers (TestSubmission; ascending id; one statement; FOR UPDATE for reviews, FOR NO KEY UPDATE otherwise) →
 *   L3 tasks (TestQuestionTask; ascending id; one statement; FOR NO KEY UPDATE) →
 *   $t = clock_timestamp() taken AFTER the locks, used for every expiry check, count and stored time →
 *   L4 rows of those tasks / papers (claims, assessments, versions, decisions, events, access, projection, COMPOSED).
 * Nothing is changed on the basis of an unlocked lookup: everything is rechecked on the locked rows.
 */
import { HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AppError } from '../../common/errors/app-error.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  DEFAULT_LOCK_MINUTES, DEFAULT_MAX_ACTIVE_CLAIMS, SETTING_LOCK_MINUTES, SETTING_MAX_ACTIVE_CLAIMS, projectPaper, qmErrors,
  type PaperStatus, type TaskRound, type TaskStatus,
} from './question-rules.js';

export type Tx = Prisma.TransactionClient;
export interface Actor { id: string; role: string }

/** Thrown when the coaches locked at L1 turned out not to cover every claim the transaction must end (5.2 §2). */
export class RetryClaim extends Error {
  constructor(readonly coaches: string[]) { super('retry with more coaches'); }
}

export interface TaskRow {
  id: string; submissionId: string; questionId: string; round: TaskRound; cycle: number; currentCycle: number;
  firstTaskId: string | null; versionId: string; status: TaskStatus; holderId: string | null; claimId: string | null;
  lockExpiresAt: Date | null; reservedForId: string | null; needsReassignment: boolean;
  reviewHoldById: string | null; reviewHoldUntil: Date | null;
}

const TASK_COLUMNS = `"id", "submissionId", "questionId", "round"::text AS "round", "cycle", "currentCycle", "firstTaskId", "versionId",
  "status"::text AS "status", "holderId", "claimId", "lockExpiresAt", "reservedForId", "needsReassignment", "reviewHoldById", "reviewHoldUntil"`;

// ── Locks ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** L1: one advisory lock per coach, ascending id, one statement each (a single SELECT … ORDER BY does not fix call order). */
export async function lockCoaches(tx: Tx, coachIds: Iterable<string | null | undefined>): Promise<string[]> {
  const ids = [...new Set([...coachIds].filter((x): x is string => !!x))].sort();
  for (const id of ids) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'marking-coach:' + id}))`;
  return ids;
}

/** L1 for the sweep: the try form; false = busy (skip this claim). */
export async function tryLockCoach(tx: Tx, coachId: string): Promise<boolean> {
  const [r] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${'marking-coach:' + coachId})) AS "ok"`;
  return r.ok;
}

export interface PaperRow { id: string; testId: string; studentId: string; publicCode: string; status: string; currentVersionId: string | null; finalMarkingId: string | null; publicationId: string | null }

/** L2: papers in ascending id, one statement, in the transaction's final mode (never upgraded). */
export async function lockPapers(tx: Tx, ids: Iterable<string>, mode: 'UPDATE' | 'NO KEY UPDATE' | 'SHARE', skipLocked = false): Promise<PaperRow[]> {
  const list = [...new Set(ids)].sort();
  if (list.length === 0) return [];
  // SHARE (heartbeat, saving a draft): they change no status, but their task update fires the commit-time paper
  // invariant, which reads the paper's status and its projection in two statements; holding the paper FOR SHARE keeps
  // every status-changing transaction (NO KEY UPDATE / UPDATE) from committing between those two reads (review
  // 2026-11-28: a heartbeat racing a review's return failed with a false "status … is not its projection …"). Shared
  // with other heartbeats and saves, so coaches on other questions of the paper never wait for each other.
  if (mode === 'SHARE') {
    return tx.$queryRaw<PaperRow[]>`
      SELECT "id", "testId", "studentId", "publicCode", "status"::text AS "status", "currentVersionId", "finalMarkingId", "publicationId"
        FROM "TestSubmission" WHERE "id" = ANY(${list}::text[]) ORDER BY "id" FOR SHARE`;
  }
  if (mode === 'UPDATE') {
    return tx.$queryRaw<PaperRow[]>`
      SELECT "id", "testId", "studentId", "publicCode", "status"::text AS "status", "currentVersionId", "finalMarkingId", "publicationId"
        FROM "TestSubmission" WHERE "id" = ANY(${list}::text[]) ORDER BY "id" FOR UPDATE`;
  }
  return skipLocked
    ? tx.$queryRaw<PaperRow[]>`
      SELECT "id", "testId", "studentId", "publicCode", "status"::text AS "status", "currentVersionId", "finalMarkingId", "publicationId"
        FROM "TestSubmission" WHERE "id" = ANY(${list}::text[]) ORDER BY "id" FOR NO KEY UPDATE SKIP LOCKED`
    : tx.$queryRaw<PaperRow[]>`
      SELECT "id", "testId", "studentId", "publicCode", "status"::text AS "status", "currentVersionId", "finalMarkingId", "publicationId"
        FROM "TestSubmission" WHERE "id" = ANY(${list}::text[]) ORDER BY "id" FOR NO KEY UPDATE`;
}

/** L3: tasks in ascending id, one statement, FOR NO KEY UPDATE (foreign-key Key Share from inserts stays compatible). */
export async function lockTasks(tx: Tx, ids: Iterable<string>, skipLocked = false): Promise<Map<string, TaskRow>> {
  const list = [...new Set(ids)].sort();
  if (list.length === 0) return new Map();
  const rows = skipLocked
    ? await tx.$queryRawUnsafe<TaskRow[]>(`SELECT ${TASK_COLUMNS} FROM "TestQuestionTask" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE SKIP LOCKED`, list)
    : await tx.$queryRawUnsafe<TaskRow[]>(`SELECT ${TASK_COLUMNS} FROM "TestQuestionTask" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR NO KEY UPDATE`, list);
  return new Map(rows.map((r) => [r.id, r]));
}

/** An unlocked read of tasks (discovery only; never trusted for changes). */
export async function readTasks(db: Tx, ids: Iterable<string>): Promise<Map<string, TaskRow>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await db.$queryRawUnsafe<TaskRow[]>(`SELECT ${TASK_COLUMNS} FROM "TestQuestionTask" WHERE "id" = ANY($1::text[])`, list);
  return new Map(rows.map((r) => [r.id, r]));
}

/** $t: wall-clock time AFTER the locks (5.2 §1). */
export async function lockedNow(tx: Tx): Promise<Date> {
  const [r] = await tx.$queryRaw<Array<{ t: Date }>>`SELECT clock_timestamp() AS "t"`;
  return r.t;
}

// ── Settings ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface QmSettings { maxActiveClaims: number; lockMinutes: number }

export async function qmSettings(db: Pick<Tx, 'systemSetting'>): Promise<QmSettings> {
  const rows = await db.systemSetting.findMany({ where: { key: { in: [SETTING_MAX_ACTIVE_CLAIMS, SETTING_LOCK_MINUTES] } }, select: { key: true, value: true } });
  const get = (k: string, d: number, lo: number, hi: number) => {
    const v = rows.find((r) => r.key === k)?.value;
    return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : d;
  };
  return { maxActiveClaims: get(SETTING_MAX_ACTIVE_CLAIMS, DEFAULT_MAX_ACTIVE_CLAIMS, 1, 50), lockMinutes: get(SETTING_LOCK_MINUTES, DEFAULT_LOCK_MINUTES, 5, 240) };
}

export const addMinutes = (t: Date, m: number) => new Date(t.getTime() + m * 60_000);

// ── Events ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function taskEvent(
  tx: Tx, t: Date, actor: Actor | null, taskId: string, action: string,
  e: { from?: string | null; to?: string | null; cycle?: number | null; reason?: string | null; meta?: Record<string, unknown> } = {},
): Promise<void> {
  await tx.testTaskEvent.create({
    data: {
      id: randomUUID(), taskId, action, fromStatus: e.from ?? null, toStatus: e.to ?? null, cycle: e.cycle ?? null,
      actorId: actor?.id ?? null, actorRole: actor?.role ?? 'SYSTEM', reason: e.reason ?? null,
      meta: (e.meta ?? undefined) as Prisma.InputJsonValue | undefined, createdAt: t,
    },
  });
}

// ── Ending a claim ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * End the task's current claim (the caller holds L1 for its coach, L2 and L3) and put the task where the reason says:
 * a pool task → NOT_STARTED with its open assessment ABANDONED; a reserved (returned) task → RETURNED with its RETURNED
 * assessment kept, or, when `unreserve`, RETURNED "needs reassignment". Returns false when the claim was no longer the
 * task's current open claim (nothing changed).
 */
export async function endCurrentClaim(
  tx: Tx, task: TaskRow, t: Date, actor: Actor | null, reason: 'EXPIRED' | 'RELEASED' | 'RELEASED_BY_STAFF' | 'REASSIGNED' | 'AUTHORISATION_LOST' | 'CANCELLED',
  opts: { expectCoach?: string; requireExpired?: boolean; unreserve?: boolean; eventReason?: string | null; keepTaskOpen?: boolean } = {},
): Promise<boolean> {
  if (task.status !== 'IN_PROGRESS' || !task.claimId) return false;
  // 5.1 §2: still active, still this coach's, still expired (where expiry is the reason), and the task still points to it.
  const ended = await tx.$executeRaw`
    UPDATE "TestTaskClaim" c SET "endedAt" = ${t}, "endReason" = ${reason}::"TaskClaimEndReason", "endedById" = ${actor?.id ?? null}
      FROM "TestQuestionTask" k
     WHERE c."id" = ${task.claimId} AND c."endedAt" IS NULL
       AND (${opts.expectCoach ?? null}::text IS NULL OR c."coachId" = ${opts.expectCoach ?? null})
       AND k."id" = c."taskId" AND k."id" = ${task.id} AND k."claimId" = c."id" AND k."holderId" = c."coachId"
       AND k."status" = 'IN_PROGRESS' AND (${opts.requireExpired ?? false} = false OR k."lockExpiresAt" < ${t})`;
  if (ended === 0) return false;
  const reserved = task.reservedForId !== null && !opts.unreserve;
  const holder = task.holderId;
  // The holder's open assessment: a pool one is abandoned; a reserved RETURNED one stays (or waits for reassignment).
  const open = await tx.testQuestionAssessment.findFirst({ where: { taskId: task.id, status: { in: ['DRAFT', 'RETURNED'] } }, select: { id: true, status: true } });
  if (open && open.status === 'DRAFT') {
    await tx.testQuestionAssessment.update({ where: { id: open.id }, data: { status: 'ABANDONED', updatedAt: t } });
    await taskEvent(tx, t, actor, task.id, 'ASSESSMENT_ABANDONED', { meta: { assessmentId: open.id, reason } });
  }
  if (!opts.keepTaskOpen) {
    const to: TaskStatus = task.reservedForId !== null ? 'RETURNED' : 'NOT_STARTED';
    await tx.testQuestionTask.update({
      where: { id: task.id },
      data: {
        status: to, holderId: null, claimId: null, lockExpiresAt: null, updatedAt: t,
        ...(task.reservedForId !== null && opts.unreserve ? { reservedForId: null, needsReassignment: true } : {}),
      },
    });
    await taskEvent(tx, t, actor, task.id, reason, { from: 'IN_PROGRESS', to, cycle: task.cycle, reason: opts.eventReason ?? null, meta: { claimId: task.claimId, coachId: holder, reserved } });
    Object.assign(task, { status: to, holderId: null, claimId: null, lockExpiresAt: null });
    if (task.reservedForId !== null && opts.unreserve) Object.assign(task, { reservedForId: null, needsReassignment: true });
  }
  return true;
}

// ── Authorisation (SQL function from the migration; the same rule as marker-reach.ts) ─────────────────────────────

export async function canMark(tx: Tx, coachId: string, questionId: string): Promise<{ marker: boolean; subject: boolean }> {
  const [r] = await tx.$queryRaw<Array<{ marker: boolean; subject: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "TestQuestionMarker" m WHERE m."questionId" = ${questionId} AND m."coachId" = ${coachId} AND m."endedAt" IS NULL) AS "marker",
           can_mark_subject(${coachId}, (SELECT t."disciplineId" FROM "TestQuestion" q JOIN "Test" t ON t."id" = q."testId" WHERE q."id" = ${questionId})) AS "subject"`;
  return r;
}

/** Open claims of a coach that still count at $t (expired ones never count — 5.1 §2). */
export async function activeClaimCount(tx: Tx, coachId: string, t: Date): Promise<number> {
  const [r] = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS "n" FROM "TestTaskClaim" c JOIN "TestQuestionTask" k ON k."claimId" = c."id"
     WHERE c."coachId" = ${coachId} AND c."endedAt" IS NULL AND k."lockExpiresAt" >= ${t}`;
  return r.n;
}

/** This coach's open claims whose lock has expired (clock_timestamp: a hint only; rechecked under the locks). */
export async function expiredClaimsOf(tx: Tx, coachId: string): Promise<Array<{ taskId: string; submissionId: string }>> {
  return tx.$queryRaw<Array<{ taskId: string; submissionId: string }>>`
    SELECT k."id" AS "taskId", k."submissionId" FROM "TestTaskClaim" c JOIN "TestQuestionTask" k ON k."claimId" = c."id"
     WHERE c."coachId" = ${coachId} AND c."endedAt" IS NULL AND k."lockExpiresAt" < clock_timestamp()`;
}

/** Recheck and end this coach's expired claims among the locked tasks (5.1 §2 / 5.2 §1: $t). */
export async function endOwnExpired(tx: Tx, coachId: string, locked: Map<string, TaskRow>, t: Date, actor: Actor | null): Promise<string[]> {
  const touched: string[] = [];
  for (const task of [...locked.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (task.status === 'IN_PROGRESS' && task.holderId === coachId && task.lockExpiresAt && task.lockExpiresAt < t) {
      if (await endCurrentClaim(tx, task, t, actor, 'EXPIRED', { expectCoach: coachId, requireExpired: true })) touched.push(task.submissionId);
    }
  }
  return touched;
}

// ── The paper projection and the COMPOSED final marking (§4, §5) ───────────────────────────────────────────────────

/**
 * Recompute each paper's status from its FIRST tasks (the caller holds the papers at L2 in the transaction's final mode
 * and has finished its task changes). Becoming APPROVED needs `composer` (only review transactions, which hold the paper
 * FOR UPDATE, may set finalMarkingId); leaving APPROVED / PUBLISHED clears finalMarkingId (the caller withdraws a
 * published result first). Writes the status history row. Returns the new status per paper.
 */
export async function projectPapers(
  tx: Tx, paperIds: Iterable<string>, actor: Actor | null, t: Date, composer?: { markerId: string },
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of [...new Set(paperIds)].sort()) {
    // A NEW statement after the task changes (READ COMMITTED sees everything committed before our paper lock).
    const [row] = await tx.$queryRaw<Array<{ status: string; finalMarkingId: string | null; publicationId: string | null; testId: string; currentVersionId: string | null }>>`
      SELECT "status"::text AS "status", "finalMarkingId", "publicationId", "testId", "currentVersionId" FROM "TestSubmission" WHERE "id" = ${id}`;
    const tasks = await tx.testQuestionTask.findMany({ where: { submissionId: id, round: 'FIRST' }, select: { status: true } });
    const projected: PaperStatus = projectPaper(tasks.map((x) => x.status as TaskStatus));
    const current = row.status;
    if (current === projected || (current === 'PUBLISHED' && projected === 'APPROVED')) { out.set(id, current); continue; }
    const data: Prisma.TestSubmissionUncheckedUpdateInput = { status: projected, updatedAt: t };
    if (projected === 'APPROVED') {
      if (!composer) throw new AppError(HttpStatus.INTERNAL_SERVER_ERROR, 'PROJECTION_WITHOUT_COMPOSER', 'Internal error: approval outside a review.');
      data.finalMarkingId = await composeFinalMarking(tx, id, row.testId, row.currentVersionId, composer.markerId, t);
    } else if (row.finalMarkingId) {
      data.finalMarkingId = null;
    }
    if (current === 'PUBLISHED' && projected !== 'APPROVED') { data.publicationId = null; data.publishedAt = null; }
    await tx.testSubmission.update({ where: { id }, data });
    await tx.testSubmissionStatusChange.create({
      data: { submissionId: id, fromStatus: current as never, toStatus: projected, actorId: actor?.id ?? null, actorRole: actor?.role ?? 'SYSTEM', reason: 'question marking', createdAt: t },
    });
    out.set(id, projected);
  }
  return out;
}

/** The COMPOSED TestMarking from the current decisions: DRAFT, one score per required question, then APPROVED. */
async function composeFinalMarking(tx: Tx, submissionId: string, testId: string, currentVersionId: string | null, markerId: string, t: Date): Promise<string> {
  const questions = await tx.testQuestion.findMany({ where: { testId }, select: { id: true }, orderBy: { order: 'asc' } });
  const test = await tx.test.findUniqueOrThrow({ where: { id: testId }, select: { maxMarks: true } });
  const firsts = await tx.testQuestionTask.findMany({
    where: { submissionId, round: 'FIRST' },
    select: { questionId: true, versionId: true, status: true, decisions: { where: { supersededAt: null }, select: { marks: true } } },
  });
  const byQ = new Map(firsts.map((f) => [f.questionId, f]));
  if (!currentVersionId) throw qmErrors.taskNotAvailable('no-version');
  const scores: Array<{ questionId: string; marks: number }> = [];
  for (const q of questions) {
    const f = byQ.get(q.id);
    if (!f || f.status !== 'APPROVED' || f.decisions.length !== 1 || f.versionId !== currentVersionId) {
      throw new AppError(HttpStatus.CONFLICT, 'COMPOSITION_INCOMPLETE', 'Every question needs one approved final mark on the current answer before the paper is approved.');
    }
    scores.push({ questionId: q.id, marks: f.decisions[0].marks });
  }
  const total = scores.reduce((a, s) => a + s.marks, 0);
  if (total > test.maxMarks) throw new AppError(HttpStatus.CONFLICT, 'COMPOSITION_OVER_MAXIMUM', 'The question marks add up to more than the test maximum.');
  const markingId = randomUUID();
  await tx.testMarking.create({ data: { id: markingId, submissionId, kind: 'COMPOSED', markerId, versionId: currentVersionId, status: 'DRAFT', createdAt: t, updatedAt: t } });
  await tx.testMarkingScore.createMany({ data: scores.map((s) => ({ id: randomUUID(), markingId, questionId: s.questionId, marks: s.marks, updatedAt: t })) });
  await tx.testMarking.update({ where: { id: markingId }, data: { status: 'APPROVED', totalMarks: total, submittedAt: t, approvedAt: t, updatedAt: t } });
  return markingId;
}

// ── Access logging (one row per claim / kind / page; staff per day in Kigali) ───────────────────────────────────────

export async function logCoachAccess(db: Tx | Prisma.TransactionClient, claimId: string, kind: 'PAPER_OPENED' | 'PAGE_VIEWED' | 'GUIDE_VIEWED', page: number): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "TestPaperAccess" ("id", "claimId", "kind", "page", "firstAt", "lastAt", "count")
    VALUES (${randomUUID()}, ${claimId}, ${kind}::"PaperAccessKind", ${page}, clock_timestamp(), clock_timestamp(), 1)
    ON CONFLICT ("claimId", "kind", "page") DO UPDATE SET "count" = "TestPaperAccess"."count" + 1, "lastAt" = clock_timestamp()`;
}

export async function logStaffAccess(db: Tx, actorId: string, submissionId: string, kind: 'PAPER_OPENED' | 'PAGE_VIEWED' | 'GUIDE_VIEWED', page: number): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "TestStaffPaperAccess" ("id", "actorId", "submissionId", "kind", "page", "day", "firstAt", "lastAt", "count")
    VALUES (${randomUUID()}, ${actorId}, ${submissionId}, ${kind}::"PaperAccessKind", ${page},
            (clock_timestamp() AT TIME ZONE 'Africa/Kigali')::date, clock_timestamp(), clock_timestamp(), 1)
    ON CONFLICT ("actorId", "submissionId", "kind", "page", "day") DO UPDATE
      SET "count" = "TestStaffPaperAccess"."count" + 1, "lastAt" = clock_timestamp()`;
}
