/**
 * Question-level marking — the COACH side (tests.mark), design Rev 5.2 §3, §6–§9. Blind: a task is addressed by the paper
 * code and the question number (`7MX2-97NP` + `q2`, a second assessment `q2-s1`); responses carry the caller's OWN
 * assessment only, never a student, another coach, another assessment or the history (assertQmBlind).
 *   queue       the shared pool of my questions (available, mine, returned to me, submitted by me; others' as "taken")
 *   claim       the claim transaction (question-claims.ts) — a new, empty assessment; reserved returned work resumes
 *   detail      question, maximum, my assessment, return reason, page list; logs PAPER_OPENED once per claim
 *   pages/paper/guide  the whole paper under neutral names; one access row per claim, kind and page
 *   heartbeat / marks  lock only the task (L3); conditional on my CURRENT claim and authorisation
 *   submit / release   L1 me → L2 paper → L3 task → $t; end my claim; projection
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

import { isCoach, unsupportedRole } from '../../common/access/roles.js';
import type { AuthUser } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { paginated } from '../../common/pagination.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { stripIdentifyingMetadataForMarker } from '../answer-metadata.js';
import { assertBlind } from '../marking-rules.js';
import { answerPageName } from '../submission-rules.js';
import { neutralFileName } from '../test-rules.js';
import { runClaim } from './question-claims.js';
import { COACH_VIEWS, HEARTBEAT_SECONDS, qmErrors, validMarks, type CoachView, type LostReason } from './question-rules.js';
import {
  addMinutes, canMark, endCurrentClaim, lockCoaches, lockPapers, lockTasks, lockedNow, logCoachAccess, projectPapers, qmSettings,
  taskEvent, type Actor, type TaskRow, type Tx,
} from './question-store.js';
import { endQuestionWorkIfUnauthorised } from './question-withdraw.js';

const WRITE_TX = { maxWait: 15_000, timeout: 30_000 } as const;
const QM_FORBIDDEN = ['assessments', 'holder', 'holderId', 'reservedFor', 'reservedForId', 'claims', 'events', 'decisions', 'versions', 'history', 'coachId'];

/** assertBlind, plus: no other assessment, holder, claim, event, decision or history in a coach response. */
export function assertQmBlind(value: unknown, path = '$'): void {
  assertBlind(value, path);
  const walk = (v: unknown, p: string) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (v === null || typeof v !== 'object' || v instanceof Date) return;
    for (const [k, x] of Object.entries(v)) {
      if (QM_FORBIDDEN.includes(k)) throw new Error(`Blind marking: "${p}.${k}" must not be sent to a marker.`);
      walk(x, `${p}.${k}`);
    }
  };
  walk(value, path);
}

/** `q2` → FIRST of question 2; `q2-s1` → SECOND, cycle 1. */
export function parseRef(ref: string): { order: number; round: 'FIRST' | 'SECOND'; cycle: number } | null {
  const m = /^q([1-9]\d{0,2})(?:-s([1-9]\d{0,2}))?$/.exec(ref);
  if (!m) return null;
  return m[2] ? { order: Number(m[1]), round: 'SECOND', cycle: Number(m[2]) } : { order: Number(m[1]), round: 'FIRST', cycle: 0 };
}

export function refOf(order: number, round: string, cycle: number): string {
  return round === 'SECOND' ? `q${order}-s${cycle}` : `q${order}`;
}

@Injectable()
export class QuestionMarkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService,
  ) {}

  /** The feature flag (QUESTION_MARKING_ENABLED): off → the routes answer 404 as if absent. */
  assertEnabled(): void {
    if (String(this.config.get('QUESTION_MARKING_ENABLED') ?? '').toLowerCase() !== 'true') {
      throw new AppError(HttpStatus.NOT_FOUND, 'FEATURE_DISABLED', 'Question marking is not enabled.');
    }
  }

  private coach(user: AuthUser): Actor {
    this.assertEnabled();
    if (!isCoach(user)) throw unsupportedRole();
    return { id: user.id, role: user.role };
  }

  // ── Queue ────────────────────────────────────────────────────────────────────────────────────────────────────────

  async queue(user: AuthUser, q: { view?: string; testId?: string; question?: number; page?: number; limit?: number }) {
    this.coach(user);
    const view: CoachView = COACH_VIEWS.includes(q.view as CoachView) ? (q.view as CoachView) : 'TO_MARK';
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 20, 100);
    const rows = await this.prisma.$queryRaw<Array<{
      taskId: string; code: string; order: number; maxMarks: number; round: string; cycle: number; testId: string; title: string;
      subject: string; state: string; lockExpiresAt: Date | null; updatedAt: Date;
    }>>`
      WITH mine AS (
        SELECT t."id" AS "taskId", s."publicCode" AS "code", q."order", q."maxMarks", t."round"::text AS "round", t."cycle",
               te."id" AS "testId", te."title", d."name" AS "subject", t."lockExpiresAt", t."updatedAt",
               CASE
                 WHEN t."status" = 'IN_PROGRESS' AND t."holderId" = ${user.id} AND t."lockExpiresAt" >= clock_timestamp() THEN 'MINE'
                 WHEN t."reservedForId" = ${user.id} AND t."status" IN ('RETURNED', 'IN_PROGRESS') THEN 'RETURNED_TO_ME'
                 WHEN (t."status" = 'NOT_STARTED' OR (t."status" = 'IN_PROGRESS' AND t."lockExpiresAt" < clock_timestamp()))
                      AND t."reservedForId" IS NULL AND NOT t."needsReassignment" THEN 'AVAILABLE'
                 WHEN t."status" = 'IN_PROGRESS' THEN 'TAKEN'
                 WHEN EXISTS (SELECT 1 FROM "TestQuestionAssessment" a WHERE a."taskId" = t."id" AND a."markerId" = ${user.id} AND a."status" IN ('SUBMITTED', 'APPROVED')) THEN 'SUBMITTED_BY_ME'
                 ELSE NULL
               END AS "state"
          FROM "TestQuestionTask" t
          JOIN "TestSubmission" s ON s."id" = t."submissionId"
          JOIN "Test" te ON te."id" = s."testId" AND te."markingMode" = 'QUESTION'
          JOIN "Discipline" d ON d."id" = te."disciplineId"
          JOIN "TestQuestion" q ON q."id" = t."questionId"
         WHERE (${q.testId ?? null}::text IS NULL OR te."id" = ${q.testId ?? null})
           AND (${q.question ?? null}::int IS NULL OR q."order" = ${q.question ?? null})
           AND t."status" NOT IN ('CLOSED', 'CANCELLED')
           AND (
             EXISTS (SELECT 1 FROM "TestQuestionAssessment" a WHERE a."taskId" = t."id" AND a."markerId" = ${user.id} AND a."status" IN ('SUBMITTED', 'APPROVED'))
             OR t."reservedForId" = ${user.id}
             OR t."holderId" = ${user.id}
             OR (EXISTS (SELECT 1 FROM "TestQuestionMarker" m WHERE m."questionId" = t."questionId" AND m."coachId" = ${user.id} AND m."endedAt" IS NULL)
                 AND can_mark_subject(${user.id}, te."disciplineId")
                 AND (t."round" = 'FIRST' OR NOT EXISTS (SELECT 1 FROM "TestQuestionAssessment" a WHERE a."taskId" = t."firstTaskId" AND a."markerId" = ${user.id}))))
      )
      SELECT * FROM mine WHERE "state" IS NOT NULL
       ORDER BY CASE "state" WHEN 'MINE' THEN 0 WHEN 'RETURNED_TO_ME' THEN 1 WHEN 'AVAILABLE' THEN 2 WHEN 'TAKEN' THEN 3 ELSE 4 END,
                "code", "order", "cycle"`;
    const inView = (state: string, v: CoachView) =>
      v === 'ALL' ? true
        : v === 'TO_MARK' ? ['AVAILABLE', 'MINE', 'RETURNED_TO_ME'].includes(state)
          : v === 'MINE' ? ['MINE', 'RETURNED_TO_ME'].includes(state)
            : v === 'RETURNED' ? state === 'RETURNED_TO_ME'
              : state === 'SUBMITTED_BY_ME';
    const counts = Object.fromEntries(COACH_VIEWS.map((v) => [v, rows.filter((r) => inView(r.state, v)).length]));
    const selected = rows.filter((r) => inView(r.state, view));
    const data = selected.slice((page - 1) * limit, page * limit).map((r) => ({
      ref: refOf(r.order, r.round, r.cycle), code: r.code, question: { order: r.order, maxMarks: r.maxMarks },
      round: r.round, cycle: r.cycle, test: { id: r.testId, title: r.title, subject: r.subject }, state: r.state,
      lockExpiresAt: r.state === 'MINE' ? r.lockExpiresAt : null,
    }));
    const tests = [...new Map(rows.map((r) => [r.testId, { id: r.testId, title: r.title, subject: r.subject }])).values()];
    const out = { ...paginated(data, selected.length, page, limit), counts, view, tests, heartbeatSeconds: HEARTBEAT_SECONDS };
    assertQmBlind(out);
    return out;
  }

  // ── Resolving a task (code + ref) ────────────────────────────────────────────────────────────────────────────────

  private async resolve(db: Tx | PrismaService, code: string, ref: string): Promise<{ id: string; submissionId: string; questionId: string }> {
    const r = parseRef(ref);
    if (!r || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) throw qmErrors.taskNotFound();
    const rows = await db.$queryRaw<Array<{ id: string; submissionId: string; questionId: string }>>`
      SELECT t."id", t."submissionId", t."questionId" FROM "TestQuestionTask" t
        JOIN "TestSubmission" s ON s."id" = t."submissionId" JOIN "TestQuestion" q ON q."id" = t."questionId"
       WHERE s."publicCode" = ${code} AND q."order" = ${r.order} AND t."round" = ${r.round}::"QuestionTaskRound" AND t."cycle" = ${r.cycle}`;
    if (!rows[0]) throw qmErrors.taskNotFound();
    return rows[0];
  }

  // ── Claim ────────────────────────────────────────────────────────────────────────────────────────────────────────

  async claim(user: AuthUser, code: string, ref: string) {
    const actor = this.coach(user);
    const task = await this.resolve(this.prisma, code, ref);
    const r = await runClaim(this.prisma, { taskId: task.id, coachId: user.id, method: 'CLAIM', actor });
    return { ...(await this.detail(user, code, ref)), claim: { method: r.method, lockExpiresAt: r.lockExpiresAt, resumed: r.resumed } };
  }

  // ── Detail and files ─────────────────────────────────────────────────────────────────────────────────────────────

  /** What the caller may see of a task: holding it, reserved for it, or having submitted on it (read only). */
  private async access(db: Tx | PrismaService, userId: string, taskId: string) {
    const [task] = await db.$queryRaw<Array<{ status: string; holderId: string | null; claimId: string | null; lockExpiresAt: Date | null; reservedForId: string | null; questionId: string; now: Date }>>`
      SELECT "status"::text AS "status", "holderId", "claimId", "lockExpiresAt", "reservedForId", "questionId", clock_timestamp() AS "now" FROM "TestQuestionTask" WHERE "id" = ${taskId}`;
    const live = task.status === 'IN_PROGRESS' && task.holderId === userId && task.lockExpiresAt !== null && task.lockExpiresAt >= task.now;
    const myLast = await db.testTaskClaim.findFirst({ where: { taskId, coachId: userId }, orderBy: { claimedAt: 'desc' }, select: { id: true, endedAt: true, endReason: true } });
    const submitted = await db.testQuestionAssessment.findFirst({ where: { taskId, markerId: userId, status: { in: ['SUBMITTED', 'APPROVED'] } }, select: { id: true } });
    const reserved = task.reservedForId === userId;
    if (!live && !reserved && !submitted) {
      if (myLast) throw qmErrors.claimLost(lostReason(myLast));
      throw new AppError(HttpStatus.FORBIDDEN, 'TASK_NOT_HELD', 'Take this question from the list first.');
    }
    // Reads enforce the CURRENT authorisation too (the paper, its pages, the guide): a coach who may no longer mark
    // this question sees none of it, and their open work ends now.
    const can = await canMark(db, userId, task.questionId);
    if (!can.subject || !can.marker) {
      if (live || reserved) await this.endIfUnauthorised(userId);
      if (live) throw qmErrors.claimLost('AUTHORISATION_LOST');
      throw new AppError(HttpStatus.FORBIDDEN, 'MARKER_NOT_AUTHORIZED', 'You may no longer mark this question. Contact the Head Coach if this is a mistake.');
    }
    return { live, claimId: live ? task.claimId! : myLast?.id ?? null, lockExpiresAt: live ? task.lockExpiresAt : null };
  }

  async detail(user: AuthUser, code: string, ref: string) {
    this.coach(user);
    const t = await this.resolve(this.prisma, code, ref);
    const acc = await this.access(this.prisma, user.id, t.id);
    const task = await this.prisma.testQuestionTask.findUniqueOrThrow({
      where: { id: t.id },
      select: {
        id: true, round: true, cycle: true, status: true, versionId: true,
        question: { select: { order: true, prompt: true, maxMarks: true, promptVersion: true } },
        submission: { select: { publicCode: true, test: { select: { id: true, title: true, maxMarks: true, discipline: { select: { name: true } }, questions: { select: { order: true }, orderBy: { order: 'asc' } }, files: { select: { kind: true } } } } } },
        version: { select: { typedAnswer: true, pages: { select: { pageNumber: true, file: { select: { mimeType: true, size: true } } }, orderBy: { pageNumber: 'asc' } } } },
      },
    });
    const mine = await this.prisma.testQuestionAssessment.findFirst({
      where: acc.live ? { taskId: t.id, markerId: user.id, status: { in: ['DRAFT', 'RETURNED'] } } : { taskId: t.id, markerId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { status: true, marks: true, comment: true, revision: true, lastVersion: true, updatedAt: true, promptVersion: true },
    });
    // The latest return of this question: a review's return, or a reopen that sent it back (review 2026-11-28: a reopen
    // records REOPENED; without it the coach saw an older reason, or none).
    const returned = await this.prisma.testTaskEvent.findFirst({
      where: { taskId: t.id, OR: [{ action: 'RETURNED' }, { action: 'REOPENED', toStatus: 'RETURNED' }] },
      orderBy: { createdAt: 'desc' }, select: { reason: true },
    });
    if (acc.live && acc.claimId) await logCoachAccess(this.prisma, acc.claimId, 'PAPER_OPENED', 0);
    const test = task.submission.test;
    const out = {
      ref, code: task.submission.publicCode, round: task.round, cycle: task.cycle, status: task.status,
      test: { id: test.id, title: test.title, subject: test.discipline.name, questionCount: test.questions.length, hasPaper: test.files.some((f) => f.kind === 'PAPER'), hasMarkingGuide: test.files.some((f) => f.kind === 'MARKING_GUIDE') },
      question: { order: task.question.order, prompt: task.question.prompt, maxMarks: task.question.maxMarks, promptVersion: task.question.promptVersion },
      answer: { typedAnswer: task.version.typedAnswer, pages: task.version.pages.map((p) => ({ pageNumber: p.pageNumber, name: answerPageName(p.pageNumber, p.file.mimeType), mimeType: p.file.mimeType, size: p.file.size })) },
      myAssessment: mine ? { status: mine.status, marks: mine.marks, comment: mine.comment, revision: mine.revision, version: mine.lastVersion, savedAt: mine.updatedAt, promptVersion: mine.promptVersion } : null,
      returnReason: mine?.status === 'RETURNED' ? returned?.reason ?? null : null,
      canEdit: acc.live && !!mine && (mine.status === 'DRAFT' || mine.status === 'RETURNED'),
      lockExpiresAt: acc.lockExpiresAt, heartbeatSeconds: HEARTBEAT_SECONDS,
      wordingChanged: !!mine && mine.promptVersion !== task.question.promptVersion,
    };
    assertQmBlind(out);
    return out;
  }

  async sendPage(user: AuthUser, code: string, ref: string, pageNumber: number, res: Response, download: boolean) {
    this.coach(user);
    const t = await this.resolve(this.prisma, code, ref);
    const acc = await this.access(this.prisma, user.id, t.id);
    const task = await this.prisma.testQuestionTask.findUniqueOrThrow({ where: { id: t.id }, select: { versionId: true } });
    const page = await this.prisma.testAnswerPage.findFirst({ where: { versionId: task.versionId, pageNumber }, select: { pageNumber: true, file: { select: { storageKey: true, mimeType: true, size: true } } } });
    if (!page) throw new AppError(HttpStatus.NOT_FOUND, 'PAGE_NOT_FOUND', 'Page not found.');
    if (acc.claimId) await logCoachAccess(this.prisma, acc.claimId, 'PAGE_VIEWED', pageNumber);
    await this.storage.send(res, { ...page.file, originalName: answerPageName(page.pageNumber, page.file.mimeType) }, {
      download, transform: (data) => stripIdentifyingMetadataForMarker(data, page.file.mimeType),
    });
  }

  async sendTestFile(user: AuthUser, code: string, ref: string, kind: 'PAPER' | 'MARKING_GUIDE', res: Response, download: boolean) {
    this.coach(user);
    const t = await this.resolve(this.prisma, code, ref);
    const acc = await this.access(this.prisma, user.id, t.id);
    // The guide this assessment was made against (reconstruction), else the test's current one.
    const mine = kind === 'MARKING_GUIDE'
      ? await this.prisma.testQuestionAssessment.findFirst({ where: { taskId: t.id, markerId: user.id }, orderBy: { createdAt: 'desc' }, select: { guideFile: { select: { storageKey: true, mimeType: true, size: true } } } })
      : null;
    const test = await this.prisma.testSubmission.findUniqueOrThrow({ where: { id: t.submissionId }, select: { test: { select: { id: true, title: true } } } });
    const link = mine?.guideFile ? { file: mine.guideFile } : await this.prisma.testFile.findUnique({ where: { testId_kind: { testId: test.test.id, kind } }, select: { file: { select: { storageKey: true, mimeType: true, size: true } } } });
    if (!link) throw new AppError(HttpStatus.NOT_FOUND, 'TEST_FILE_NOT_FOUND', 'This test has no such file.');
    if (acc.claimId && kind === 'MARKING_GUIDE') await logCoachAccess(this.prisma, acc.claimId, 'GUIDE_VIEWED', 0);
    await this.storage.send(res, { ...link.file, originalName: neutralFileName(kind, link.file.storageKey, test.test.title) }, { download });
  }

  // ── Writes on my current claim ───────────────────────────────────────────────────────────────────────────────────

  /**
   * A coach who may no longer mark (authorisation revoked, account suspended, removed from the question): their open
   * claims and reserved returns end NOW, in their own transaction in lock order (L1 coach → L2 papers → L3 tasks) —
   * the refused request never leaves the question held until the sweep.
   */
  private async endIfUnauthorised(userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await lockCoaches(tx, [userId]);
      await endQuestionWorkIfUnauthorised(tx, userId, null, 'The coach may no longer mark this question.');
    }, WRITE_TX);
  }

  /** Runs a write on my claim; when my authorisation is gone, ends my work and answers CLAIM_LOST (AUTHORISATION_LOST). */
  private async onMyClaim<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AuthorisationLost) {
        await this.endIfUnauthorised(userId);
        throw qmErrors.claimLost('AUTHORISATION_LOST');
      }
      throw e;
    }
  }

  /** The locked task, checked: held by me on a live claim and I may still mark it — else CLAIM_LOST with its reason. */
  private async held(tx: Tx, userId: string, task: TaskRow, t: Date) {
    if (!(task.status === 'IN_PROGRESS' && task.holderId === userId && task.lockExpiresAt && task.lockExpiresAt >= t && task.claimId)) {
      const last = await tx.testTaskClaim.findFirst({ where: { taskId: task.id, coachId: userId }, orderBy: { claimedAt: 'desc' }, select: { endedAt: true, endReason: true } });
      throw qmErrors.claimLost(last ? lostReason(last) : 'RELEASED');
    }
    const can = await canMark(tx, userId, task.questionId);
    if (!can.subject || !can.marker) throw new AuthorisationLost();
    return task.claimId;
  }

  async heartbeat(user: AuthUser, code: string, ref: string) {
    this.coach(user);
    const ref0 = await this.resolve(this.prisma, code, ref);
    const out = await this.onMyClaim(user.id, () => this.prisma.$transaction(async (tx) => {
      await lockPapers(tx, [ref0.submissionId], 'SHARE');   // L2 (shared) before L3: see lockPapers
      const task = (await lockTasks(tx, [ref0.id])).get(ref0.id)!;
      const t = await lockedNow(tx);
      const claimId = await this.held(tx, user.id, task, t);
      const s = await qmSettings(tx);
      const lockExpiresAt = addMinutes(t, s.lockMinutes);
      await tx.testQuestionTask.update({ where: { id: task.id }, data: { lockExpiresAt, updatedAt: t } });
      await tx.testTaskClaim.update({ where: { id: claimId }, data: { lastActiveAt: t } });
      return { lockExpiresAt };
    }, WRITE_TX));
    const wording = await this.prisma.testQuestionTask.findUniqueOrThrow({ where: { id: ref0.id }, select: { question: { select: { promptVersion: true } }, assessments: { where: { markerId: user.id, status: { in: ['DRAFT', 'RETURNED'] } }, select: { promptVersion: true } } } });
    return { ...out, heartbeatSeconds: HEARTBEAT_SECONDS, wordingChanged: wording.assessments.some((a) => a.promptVersion !== wording.question.promptVersion) };
  }

  /** Save my draft for this question only: { marks, comment, expectedRevision }. */
  async saveMarks(user: AuthUser, code: string, ref: string, dto: { marks?: number | null; comment?: string | null; expectedRevision?: number }) {
    const actor = this.coach(user);
    const r = await this.resolve(this.prisma, code, ref);
    await this.onMyClaim(user.id, () => this.prisma.$transaction(async (tx) => {
      await lockPapers(tx, [r.submissionId], 'SHARE');   // L2 (shared) before L3: see lockPapers
      const task = (await lockTasks(tx, [r.id])).get(r.id)!;
      const t = await lockedNow(tx);
      const claimId = await this.held(tx, user.id, task, t);
      await this.writeDraft(tx, task, claimId, actor, dto, t);
    }, WRITE_TX));
    return this.detail(user, code, ref);
  }

  private async writeDraft(tx: Tx, task: TaskRow, claimId: string, actor: Actor, dto: { marks?: number | null; comment?: string | null; expectedRevision?: number }, t: Date) {
    const q = await tx.testQuestion.findUniqueOrThrow({ where: { id: task.questionId }, select: { maxMarks: true } });
    const a = await tx.testQuestionAssessment.findFirst({ where: { taskId: task.id, markerId: actor.id, status: { in: ['DRAFT', 'RETURNED'] } }, select: { id: true, marks: true, comment: true, revision: true } });
    if (!a) throw qmErrors.claimLost('RELEASED');
    if (dto.expectedRevision !== undefined && dto.expectedRevision !== a.revision) throw qmErrors.markingChanged(a.revision);
    const marks = dto.marks === undefined ? a.marks : dto.marks;
    if (!validMarks(marks, q.maxMarks)) throw qmErrors.marksInvalid(q.maxMarks);
    const comment = dto.comment === undefined ? a.comment : (dto.comment?.trim() || null);
    if (marks !== a.marks || comment !== a.comment) {
      await tx.testQuestionAssessment.update({ where: { id: a.id }, data: { marks, comment, revision: { increment: 1 }, updatedAt: t } });
      await tx.testMarkDraftChange.create({ data: { id: randomUUID(), assessmentId: a.id, oldMarks: a.marks, newMarks: marks, commentChanged: comment !== a.comment, actorId: actor.id, createdAt: t } });
    }
    const s = await qmSettings(tx);
    await tx.testQuestionTask.update({ where: { id: task.id }, data: { lockExpiresAt: addMinutes(t, s.lockMinutes), updatedAt: t } });
    await tx.testTaskClaim.update({ where: { id: claimId }, data: { lastActiveAt: t } });
    return a.id;
  }

  /** Submit this question only (the given marks are saved first). */
  async submit(user: AuthUser, code: string, ref: string, dto: { marks?: number | null; comment?: string | null; expectedRevision?: number }) {
    const actor = this.coach(user);
    const r = await this.resolve(this.prisma, code, ref);
    await this.onMyClaim(user.id, () => this.prisma.$transaction(async (tx) => {
      await lockCoaches(tx, [user.id]);
      await lockPapers(tx, [r.submissionId], 'NO KEY UPDATE');
      const task = (await lockTasks(tx, [r.id])).get(r.id)!;
      const t = await lockedNow(tx);
      const claimId = await this.held(tx, user.id, task, t);
      const assessmentId = await this.writeDraft(tx, task, claimId, actor, dto, t);
      const a = await tx.testQuestionAssessment.findUniqueOrThrow({ where: { id: assessmentId }, select: { marks: true, comment: true, lastVersion: true } });
      if (a.marks === null) throw qmErrors.marksIncomplete();
      const version = a.lastVersion + 1;
      await tx.testAssessmentVersion.create({ data: { id: randomUUID(), assessmentId, version, marks: a.marks, comment: a.comment, submittedAt: t } });
      await tx.testQuestionAssessment.update({ where: { id: assessmentId }, data: { status: 'SUBMITTED', lastVersion: version, updatedAt: t } });
      await tx.testTaskClaim.update({ where: { id: claimId }, data: { endedAt: t, endReason: 'SUBMITTED', lastActiveAt: t } });
      await tx.testQuestionTask.update({ where: { id: task.id }, data: { status: 'SUBMITTED', holderId: null, claimId: null, lockExpiresAt: null, reservedForId: null, needsReassignment: false, updatedAt: t } });
      await taskEvent(tx, t, actor, task.id, 'SUBMITTED', { from: 'IN_PROGRESS', to: 'SUBMITTED', cycle: task.cycle, meta: { version, marks: a.marks, assessmentId } });
      await projectPapers(tx, [task.submissionId], actor, t);
    }, WRITE_TX));
    return this.detail(user, code, ref);
  }

  /** Give the task back: the claim ends; a pool assessment is ABANDONED (kept for staff); returned work stays reserved. */
  async release(user: AuthUser, code: string, ref: string) {
    const actor = this.coach(user);
    const r = await this.resolve(this.prisma, code, ref);
    await this.onMyClaim(user.id, () => this.prisma.$transaction(async (tx) => {
      await lockCoaches(tx, [user.id]);
      await lockPapers(tx, [r.submissionId], 'NO KEY UPDATE');
      const task = (await lockTasks(tx, [r.id])).get(r.id)!;
      const t = await lockedNow(tx);
      if (!(task.status === 'IN_PROGRESS' && task.holderId === user.id)) throw qmErrors.claimLost('RELEASED');
      // Giving work back is a marking action too: a coach who may no longer mark is refused, and the claim ends
      // AUTHORISATION_LOST (onMyClaim), never recorded as an ordinary release.
      const can = await canMark(tx, user.id, task.questionId);
      if (!can.subject || !can.marker) throw new AuthorisationLost();
      await endCurrentClaim(tx, task, t, actor, 'RELEASED', { expectCoach: user.id });
      await projectPapers(tx, [task.submissionId], actor, t);
    }, WRITE_TX));
    return { released: true };
  }
}

/** Thrown inside a write transaction when the holder may no longer mark: caught outside it (onMyClaim). */
class AuthorisationLost extends Error {}

function lostReason(last: { endedAt: Date | null; endReason: string | null }): LostReason {
  if (!last.endedAt) return 'EXPIRED';                      // open but past its lock
  return (last.endReason ?? 'EXPIRED') as LostReason;
}
