/**
 * Question-level marking — the STAFF side (Head Coach in their subjects, Administrator, Super Admin), design Rev 5.2
 * §3, §4, §6, §7, §9, §10. Every review action locks the paper FOR UPDATE at L2 (it may set finalMarkingId, which takes
 * PostgreSQL's full row lock), then the task(s) at L3, then $t, and changes a task only by a conditional transition
 * (TASK_CHANGED to the reviewer who lost). G4: Administrators and Super Admins never mark nor decide marks.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

import { AuditService } from '../../audit/audit.service.js';
import type { AuthUser } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { paginated } from '../../common/pagination.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { DecisionEvents } from '../../decision-notifications/decision-content.js';
import { DecisionNotificationsService } from '../../decision-notifications/decision-notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { mayMarkWhere } from '../marker-reach.js';
import { coachProblems } from '../marking-store.js';
import { activeStudents, resultNotices, schoolTeachersOf } from '../results-store.js';
import { answerPageName } from '../submission-rules.js';
import { lockTest, TestsService } from '../tests.service.js';
import { runClaim } from './question-claims.js';
import { QuestionMarkerService } from './question-marker.service.js';
import { REVIEW_HOLD_MINUTES, paperProgress, qmErrors, validMarks, type TaskStatus } from './question-rules.js';
import {
  RetryClaim, addMinutes, endCurrentClaim, lockCoaches, lockPapers, lockTasks, lockedNow, logStaffAccess, projectPapers, readTasks,
  taskEvent, type Actor, type TaskRow, type Tx,
} from './question-store.js';
import { withdrawQuestionWork } from './question-withdraw.js';

const REVIEW_TX = { maxWait: 15_000, timeout: 30_000 } as const;
/** The paper-level TestReview row of a withdrawal (as UNLOCK records today); not an audit action. */
const REVIEW_UNLOCKED = 'UNLOCKED' as const;
type Notices = Array<string | null>;

@Injectable()
export class QuestionMarkingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tests: TestsService,
    private readonly audit: AuditService,
    private readonly notices: DecisionNotificationsService,
    private readonly storage: StorageService,
    private readonly marker: QuestionMarkerService,
  ) {}

  private actor(user: AuthUser): Actor { this.marker.assertEnabled(); return { id: user.id, role: user.role }; }

  /** The test in the caller's scope, and in QUESTION mode (or 409 WRONG_MARKING_MODE). */
  private async questionTest(testId: string, user: AuthUser) {
    this.marker.assertEnabled();
    await this.tests.loadInScope(testId, user);
    const t = await this.prisma.test.findUniqueOrThrow({ where: { id: testId }, select: { id: true, title: true, markingMode: true, disciplineId: true, maxMarks: true, discipline: { select: { name: true } } } });
    if (t.markingMode !== 'QUESTION') throw qmErrors.wrongMode(t.markingMode);
    return t;
  }

  /** A task of this test (unlocked lookup). */
  private async taskOf(testId: string, taskId: string) {
    const rows = await this.prisma.$queryRaw<Array<{ id: string; submissionId: string; round: string; firstTaskId: string | null }>>`
      SELECT t."id", t."submissionId", t."round"::text AS "round", t."firstTaskId" FROM "TestQuestionTask" t JOIN "TestSubmission" s ON s."id" = t."submissionId"
       WHERE t."id" = ${taskId} AND s."testId" = ${testId}`;
    if (!rows[0]) throw qmErrors.taskNotFound();
    return rows[0];
  }

  // ── Mode ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  async setMode(testId: string, mode: 'PAPER' | 'QUESTION', user: AuthUser) {
    this.actor(user);
    await this.tests.loadInScope(testId, user);
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      if (test.markingMode === mode) return;
      const [started] = await tx.$queryRaw<Array<{ started: boolean; nonsubmitted: boolean; reviews: boolean }>>`
        SELECT question_marking_started(${testId}) AS "started",
               EXISTS (SELECT 1 FROM "TestSubmission" s WHERE s."testId" = ${testId} AND s."status" <> 'SUBMITTED') AS "nonsubmitted",
               EXISTS (SELECT 1 FROM "TestReview" r JOIN "TestSubmission" s ON s."id" = r."submissionId" WHERE s."testId" = ${testId}) AS "reviews"`;
      if (started.started || started.nonsubmitted || started.reviews) throw qmErrors.markingStarted();
      if (mode === 'QUESTION' && (await tx.testQuestion.count({ where: { testId } })) === 0) throw qmErrors.noQuestions();
      await tx.test.update({ where: { id: testId }, data: { markingMode: mode } });
      await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'TEST_MARKING_MODE_CHANGED', entity: 'Test', entityId: testId, metadata: { from: test.markingMode, to: mode } }, tx);
    }, REVIEW_TX);
    return this.overview(testId, user);
  }

  // ── Question markers ─────────────────────────────────────────────────────────────────────────────────────────────

  async markers(testId: string, user: AuthUser) {
    const test = await this.questionTest(testId, user);
    const [questions, candidates] = await Promise.all([
      this.prisma.testQuestion.findMany({
        where: { testId }, orderBy: { order: 'asc' },
        select: { id: true, order: true, maxMarks: true, qmMarkers: { where: { endedAt: null }, select: { coachId: true, grantedAt: true, coach: { select: { id: true, firstName: true, lastName: true, username: true } } } } },
      }),
      this.prisma.user.findMany({ where: { ...mayMarkWhere(test.disciplineId), accountStatus: 'ACTIVE' }, select: { id: true, firstName: true, lastName: true, username: true }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }] }),
    ]);
    return {
      test: { id: test.id, title: test.title, subject: test.discipline.name },
      questions: questions.map((q) => ({ id: q.id, order: q.order, maxMarks: q.maxMarks, coaches: q.qmMarkers.map((m) => ({ ...m.coach, since: m.grantedAt })), unassigned: q.qmMarkers.length === 0 })),
      candidates,
    };
  }

  async setMarkers(testId: string, questionId: string, dto: { add?: string[]; remove?: string[]; reason?: string }, user: AuthUser) {
    const actor = this.actor(user);
    const test = await this.questionTest(testId, user);
    const q = await this.prisma.testQuestion.findFirst({ where: { id: questionId, testId }, select: { id: true } });
    if (!q) throw new AppError(HttpStatus.NOT_FOUND, 'QUESTION_NOT_FOUND', 'This question is not part of the test.');
    const add = [...new Set(dto.add ?? [])];
    const remove = [...new Set(dto.remove ?? [])].filter((c) => !add.includes(c));
    if (remove.length && !(dto.reason && dto.reason.trim().length >= 3)) throw qmErrors.reasonRequired();
    const notices: Notices = [];
    await this.prisma.$transaction(async (tx) => {
      // L1 first for every coach whose claims may end (the removed ones); then L1-auth: the marker rows.
      await lockCoaches(tx, remove);
      if (add.length) {
        const problems = await coachProblems(tx, add, test.disciplineId);
        if (problems.size) throw new AppError(HttpStatus.BAD_REQUEST, 'COACH_NOT_AUTHORIZED', 'Only active coaches authorised to mark this subject can be given a question.', { coaches: [...problems].map(([coachId, problem]) => ({ coachId, problem })) });
      }
      const t0 = await lockedNow(tx);
      for (const coachId of add) {
        const exists = await tx.testQuestionMarker.count({ where: { questionId, coachId, endedAt: null } });
        if (!exists) await tx.testQuestionMarker.create({ data: { id: randomUUID(), questionId, coachId, grantedById: user.id, grantedAt: t0, reason: dto.reason?.trim() || null } });
      }
      if (remove.length) {
        await tx.testQuestionMarker.updateMany({ where: { questionId, coachId: { in: remove }, endedAt: null }, data: { endedAt: t0, endedById: user.id, endReason: dto.reason!.trim() } });
        await withdrawQuestionWork(tx, remove, { questionIds: [questionId] }, actor, dto.reason!.trim());
      }
      await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'TEST_QUESTION_MARKERS_CHANGED', entity: 'TestQuestion', entityId: questionId, metadata: { testId, add, remove, reason: dto.reason ?? null } }, tx);
    }, REVIEW_TX);
    this.notices.dispatchAfterCommit(notices);
    return this.markers(testId, user);
  }

  // ── Task generation (idempotent) ─────────────────────────────────────────────────────────────────────────────────

  async generate(testId: string, user: AuthUser) {
    this.actor(user);
    await this.questionTest(testId, user);
    return this.prisma.$transaction(async (tx) => {
      await lockTest(tx, testId);                       // L0: one generation per test at a time
      const questions = await tx.testQuestion.findMany({ where: { testId }, orderBy: { order: 'asc' }, select: { id: true } });
      const papers = await tx.$queryRaw<Array<{ id: string; publicCode: string; currentVersionId: string | null; eligible: boolean; pending: boolean; hasTasks: boolean }>>`
        SELECT s."id", s."publicCode", s."currentVersionId",
               clock_timestamp() > GREATEST(t."closesAt", COALESCE((SELECT max(e."newDeadline") FROM "TestExtension" e
                   WHERE e."testId" = s."testId" AND e."cancelledAt" IS NULL AND (e."kind" = 'TEST' OR (e."kind" = 'STUDENT' AND e."studentId" = s."studentId")
                      OR (e."kind" = 'TEACHER' AND (EXISTS (SELECT 1 FROM "TestSubmissionVersion" v WHERE v."submissionId" = s."id" AND v."teacherId" = e."teacherId")
                         OR EXISTS (SELECT 1 FROM "TeacherSchoolAssignment" ta JOIN "StudentSchoolAffiliation" f ON f."schoolId" = ta."schoolId"
                                     WHERE ta."teacherId" = e."teacherId" AND ta."isActive" AND f."studentId" = s."studentId" AND f."status" IN ('PENDING', 'VERIFIED') AND f."supersededAt" IS NULL)
                         OR EXISTS (SELECT 1 FROM "TeacherStudentAssignment" sa WHERE sa."teacherId" = e."teacherId" AND sa."studentId" = s."studentId" AND sa."isActive"))))), t."closesAt")) AS "eligible",
               EXISTS (SELECT 1 FROM "TestResubmissionAuthorization" r WHERE r."submissionId" = s."id" AND r."usedAt" IS NULL AND r."cancelledAt" IS NULL) AS "pending",
               EXISTS (SELECT 1 FROM "TestQuestionTask" k WHERE k."submissionId" = s."id") AS "hasTasks"
          FROM "TestSubmission" s JOIN "Test" t ON t."id" = s."testId"
         WHERE s."testId" = ${testId} ORDER BY s."id"`;
      const now = await lockedNow(tx);
      let created = 0;
      const skipped: Array<{ code: string; reason: string }> = [];
      for (const p of papers) {
        if (!p.currentVersionId) { skipped.push({ code: p.publicCode, reason: 'NO_ANSWER' }); continue; }
        if (!p.eligible) { skipped.push({ code: p.publicCode, reason: 'DEADLINE_NOT_PASSED' }); continue; }
        if (p.pending) { skipped.push({ code: p.publicCode, reason: 'RESUBMISSION_PENDING' }); continue; }
        for (const q of questions) {
          created += await tx.$executeRaw`
            INSERT INTO "TestQuestionTask" ("id", "submissionId", "questionId", "round", "cycle", "currentCycle", "versionId", "status", "needsReassignment", "createdAt", "updatedAt")
            VALUES (${randomUUID()}, ${p.id}, ${q.id}, 'FIRST', 0, 0, ${p.currentVersionId}, 'NOT_STARTED', false, ${now}, ${now})
            ON CONFLICT ("submissionId", "questionId", "round", "cycle") DO NOTHING`;
        }
      }
      await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'TEST_QUESTION_TASKS_GENERATED', entity: 'Test', entityId: testId, metadata: { created, skipped: skipped.length } }, tx);
      return { created, papers: papers.length, questions: questions.length, skipped };
    }, REVIEW_TX);
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

  async listTasks(testId: string, q: { question?: number; status?: string; coachId?: string; code?: string; round?: string; page?: number; limit?: number }, user: AuthUser) {
    await this.questionTest(testId, user);
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 50, 200);
    const where = {
      submission: { testId, ...(q.code && { publicCode: q.code.toUpperCase() }) },
      ...(q.question && { question: { order: q.question } }),
      ...(q.status && { status: q.status as TaskStatus }),
      ...(q.round && { round: q.round as 'FIRST' | 'SECOND' }),
      ...(q.coachId && { OR: [{ holderId: q.coachId }, { reservedForId: q.coachId }, { assessments: { some: { markerId: q.coachId } } }] }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.testQuestionTask.findMany({
        where, skip: (page - 1) * limit, take: limit,
        orderBy: [{ submission: { publicCode: 'asc' } }, { question: { order: 'asc' } }, { round: 'asc' }, { cycle: 'asc' }],
        select: {
          id: true, round: true, cycle: true, currentCycle: true, status: true, lockExpiresAt: true, needsReassignment: true, updatedAt: true,
          question: { select: { order: true, maxMarks: true } },
          submission: { select: { id: true, publicCode: true, student: { select: { id: true, firstName: true, lastName: true, username: true } } } },
          holder: { select: { id: true, firstName: true, lastName: true } }, reservedFor: { select: { id: true, firstName: true, lastName: true } },
          decisions: { where: { supersededAt: null }, select: { marks: true, source: true } },
          assessments: { where: { status: { in: ['SUBMITTED', 'APPROVED'] } }, orderBy: { createdAt: 'desc' }, take: 1, select: { marks: true, lastVersion: true, marker: { select: { id: true, firstName: true, lastName: true } } } },
        },
      }),
      this.prisma.testQuestionTask.count({ where }),
    ]);
    return paginated(rows.map((r) => ({ ...r, finalMarks: r.decisions[0]?.marks ?? null, decisionSource: r.decisions[0]?.source ?? null, submitted: r.assessments[0] ?? null, decisions: undefined, assessments: undefined })), total, page, limit);
  }

  async taskDetail(testId: string, taskId: string, user: AuthUser) {
    await this.questionTest(testId, user);
    const ref = await this.taskOf(testId, taskId);
    const firstId = ref.round === 'FIRST' ? ref.id : ref.firstTaskId!;
    const task = await this.prisma.testQuestionTask.findUniqueOrThrow({
      where: { id: firstId },
      select: {
        id: true, round: true, cycle: true, currentCycle: true, status: true, lockExpiresAt: true, needsReassignment: true, reviewHoldUntil: true, versionId: true,
        question: { select: { id: true, order: true, prompt: true, maxMarks: true, promptVersion: true } },
        submission: { select: { id: true, publicCode: true, status: true, student: { select: { id: true, firstName: true, lastName: true, username: true } }, currentVersion: { select: { typedAnswer: true, pages: { select: { pageNumber: true, file: { select: { mimeType: true } } }, orderBy: { pageNumber: 'asc' } } } } } },
        holder: { select: { id: true, firstName: true, lastName: true } }, reservedFor: { select: { id: true, firstName: true, lastName: true } },
        decisions: { orderBy: { decidedAt: 'asc' }, select: { id: true, cycle: true, source: true, marks: true, reason: true, decidedAt: true, supersededAt: true, supersedeReason: true, decidedBy: { select: { id: true, firstName: true, lastName: true, role: true } } } },
      },
    });
    const allTasks = await this.prisma.testQuestionTask.findMany({ where: { OR: [{ id: firstId }, { firstTaskId: firstId }] }, orderBy: [{ round: 'asc' }, { cycle: 'asc' }], select: { id: true, round: true, cycle: true, status: true, holder: { select: { id: true, firstName: true, lastName: true } }, lockExpiresAt: true } });
    const ids = allTasks.map((x) => x.id);
    const [assessments, claims, events] = await Promise.all([
      this.prisma.testQuestionAssessment.findMany({ where: { taskId: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { id: true, taskId: true, status: true, marks: true, comment: true, revision: true, lastVersion: true, promptVersion: true, guideFileId: true, createdAt: true, updatedAt: true, marker: { select: { id: true, firstName: true, lastName: true } }, versions: { orderBy: { version: 'asc' }, select: { id: true, version: true, marks: true, comment: true, submittedAt: true } } } }),
      this.prisma.testTaskClaim.findMany({ where: { taskId: { in: ids } }, orderBy: { claimedAt: 'asc' }, select: { id: true, taskId: true, method: true, claimedAt: true, lastActiveAt: true, endedAt: true, endReason: true, coach: { select: { id: true, firstName: true, lastName: true } } } }),
      this.prisma.testTaskEvent.findMany({ where: { taskId: { in: ids } }, orderBy: { createdAt: 'asc' }, select: { id: true, taskId: true, action: true, fromStatus: true, toStatus: true, cycle: true, actorRole: true, reason: true, createdAt: true, actor: { select: { id: true, firstName: true, lastName: true } } } }),
    ]);
    await this.prisma.$transaction((tx) => logStaffAccess(tx, user.id, task.submission.id, 'PAPER_OPENED', 0));
    const second = allTasks.find((x) => x.round === 'SECOND' && x.cycle === task.currentCycle) ?? null;
    return {
      task: { ...task, decisions: undefined }, tasks: allTasks, currentSecond: second,
      decisions: task.decisions, assessments, claims, events,
      allowed: allowedActions(task.status as TaskStatus, second?.status as TaskStatus | undefined, user.role),
    };
  }

  async sendPage(testId: string, submissionId: string, pageNumber: number, user: AuthUser, res: Response, download: boolean) {
    await this.questionTest(testId, user);
    const sub = await this.prisma.testSubmission.findFirst({ where: { id: submissionId, testId }, select: { currentVersionId: true } });
    if (!sub?.currentVersionId) throw new AppError(HttpStatus.NOT_FOUND, 'PAGE_NOT_FOUND', 'Page not found.');
    const page = await this.prisma.testAnswerPage.findFirst({ where: { versionId: sub.currentVersionId, pageNumber }, select: { pageNumber: true, file: { select: { storageKey: true, mimeType: true, size: true } } } });
    if (!page) throw new AppError(HttpStatus.NOT_FOUND, 'PAGE_NOT_FOUND', 'Page not found.');
    await this.prisma.$transaction((tx) => logStaffAccess(tx, user.id, submissionId, 'PAGE_VIEWED', pageNumber));
    await this.storage.send(res, { ...page.file, originalName: answerPageName(page.pageNumber, page.file.mimeType) }, { download });
  }

  // ── Direct assignment and staff release ──────────────────────────────────────────────────────────────────────────

  async assign(testId: string, taskId: string, dto: { coachId: string; reason: string }, user: AuthUser) {
    const actor = this.actor(user);
    const test = await this.questionTest(testId, user);
    if (!dto.reason || dto.reason.trim().length < 3) throw qmErrors.reasonRequired();
    await this.taskOf(testId, taskId);
    const r = await runClaim(this.prisma, { taskId, coachId: dto.coachId, method: 'ASSIGN', actor, reason: dto.reason.trim() });
    const notices: Notices = [];
    await this.prisma.$transaction(async (tx) => {
      await this.notifyCoach(tx, test, dto.coachId, DecisionEvents.TestMarkingAssigned, `qm-assigned:${r.claimId}`, notices);
      if (r.previousHolder && r.previousHolder !== dto.coachId) await this.notifyCoach(tx, test, r.previousHolder, DecisionEvents.TestMarkingReturned, `qm-reassigned:${r.claimId}`, notices);
      await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'TEST_QUESTION_TASK_ASSIGNED', entity: 'TestQuestionTask', entityId: taskId, metadata: { testId, coachId: dto.coachId, previousHolder: r.previousHolder, reason: dto.reason } }, tx);
    });
    this.notices.dispatchAfterCommit(notices);
    return this.taskDetail(testId, taskId, user);
  }

  async release(testId: string, taskId: string, dto: { reason: string }, user: AuthUser) {
    const actor = this.actor(user);
    await this.questionTest(testId, user);
    if (!dto.reason || dto.reason.trim().length < 3) throw qmErrors.reasonRequired();
    const ref = await this.taskOf(testId, taskId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const seen = (await readTasks(tx, [taskId])).get(taskId)!;
          const locked = await lockCoaches(tx, [seen.holderId]);
          await lockPapers(tx, [ref.submissionId], 'NO KEY UPDATE');
          const task = (await lockTasks(tx, [taskId])).get(taskId)!;
          const t = await lockedNow(tx);
          if (task.status !== 'IN_PROGRESS' || !task.holderId) throw qmErrors.taskChanged({ status: task.status });
          if (!locked.includes(task.holderId)) throw new RetryClaim([task.holderId]);
          await endCurrentClaim(tx, task, t, actor, 'RELEASED_BY_STAFF', { expectCoach: task.holderId, eventReason: dto.reason.trim() });
          await projectPapers(tx, [task.submissionId], actor, t);
          await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'TEST_QUESTION_TASK_RELEASED', entity: 'TestQuestionTask', entityId: taskId, metadata: { testId, reason: dto.reason } }, tx);
        }, REVIEW_TX);
        break;
      } catch (e) {
        if (e instanceof RetryClaim && attempt < 3) continue;
        if (e instanceof RetryClaim) throw qmErrors.taskChanged({ reason: 'holder-changed' });
        throw e;
      }
    }
    return this.taskDetail(testId, taskId, user);
  }

  // ── Review ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /** One review transaction: L2 paper FOR UPDATE → L3 tasks (FIRST and, when needed, the current SECOND) → $t. */
  private async review<T>(
    testId: string, taskId: string, user: AuthUser, opts: { audit: string; coachLocks?: (seen: TaskRow, second: TaskRow | null) => string[] },
    step: (tx: Tx, first: TaskRow, second: TaskRow | null, t: Date, actor: Actor, notices: Notices) => Promise<T>,
  ): Promise<T> {
    const actor = this.actor(user);
    const test = await this.questionTest(testId, user);
    const ref = await this.taskOf(testId, taskId);
    const firstId = ref.round === 'FIRST' ? ref.id : ref.firstTaskId!;
    const notices: Notices = [];
    const out = await this.prisma.$transaction(async (tx) => {
      const seenFirst = (await readTasks(tx, [firstId])).get(firstId)!;
      const seenSecond = seenFirst.currentCycle > 0
        ? (await tx.testQuestionTask.findFirst({ where: { firstTaskId: firstId, cycle: seenFirst.currentCycle }, select: { id: true } }))?.id ?? null
        : null;
      const seen2 = seenSecond ? (await readTasks(tx, [seenSecond])).get(seenSecond)! : null;
      const locked = await lockCoaches(tx, opts.coachLocks?.(seenFirst, seen2) ?? []);
      await lockPapers(tx, [ref.submissionId], 'UPDATE');
      const tasks = await lockTasks(tx, [firstId, ...(seenSecond ? [seenSecond] : [])]);
      const t = await lockedNow(tx);
      const first = tasks.get(firstId)!;
      if (first.currentCycle !== seenFirst.currentCycle) throw qmErrors.taskChanged({ status: first.status, cycle: first.currentCycle });
      const second = seenSecond ? tasks.get(seenSecond)! : null;
      if (second?.status === 'IN_PROGRESS' && second.holderId && opts.coachLocks && !locked.includes(second.holderId)) throw qmErrors.taskChanged({ reason: 'holder-changed' });
      const r = await step(tx, first, second, t, actor, notices);
      await this.audit.log({ actorId: user.id, actorRole: user.role, action: opts.audit, entity: 'TestQuestionTask', entityId: taskId, metadata: { testId, title: test.title, firstTaskId: firstId } }, tx);
      return r;
    }, REVIEW_TX);
    this.notices.dispatchAfterCommit(notices);
    return out;
  }

  private expect(task: TaskRow, allowed: TaskStatus[], dto: { expectedStatus?: string; cycleSeen?: number }, t: Date) {
    const status = effectiveStatus(task, t);
    if (!allowed.includes(status) || (dto.expectedStatus && dto.expectedStatus !== status) || (dto.cycleSeen !== undefined && dto.cycleSeen !== task.currentCycle)) {
      throw qmErrors.taskChanged({ status, cycle: task.currentCycle });
    }
  }

  private async latestSubmitted(tx: Tx, taskId: string) {
    const a = await tx.testQuestionAssessment.findFirst({ where: { taskId, status: { in: ['SUBMITTED', 'APPROVED'] } }, orderBy: { updatedAt: 'desc' }, select: { id: true, markerId: true, status: true, versions: { orderBy: { version: 'desc' }, take: 1, select: { id: true, marks: true } } } });
    if (!a || !a.versions[0]) throw qmErrors.taskChanged({ reason: 'no-submitted-assessment' });
    return { ...a, version: a.versions[0] };
  }

  async reviewHold(testId: string, taskId: string, user: AuthUser) {
    await this.review(testId, taskId, user, { audit: 'TEST_QUESTION_REVIEW_HOLD' }, async (tx, first, _s, t, actor) => {
      this.expect(first, ['SUBMITTED', 'UNDER_REVIEW'], {}, t);
      await tx.testQuestionTask.update({ where: { id: first.id }, data: { status: 'UNDER_REVIEW', reviewHoldById: actor.id, reviewHoldUntil: addMinutes(t, REVIEW_HOLD_MINUTES), updatedAt: t } });
      if (first.status !== 'UNDER_REVIEW') await taskEvent(tx, t, actor, first.id, 'REVIEW_HOLD', { from: first.status, to: 'UNDER_REVIEW' });
    });
    return this.taskDetail(testId, taskId, user);
  }

  async approve(testId: string, taskId: string, dto: { expectedStatus?: string; cycleSeen?: number }, user: AuthUser) {
    await this.review(testId, taskId, user, { audit: 'TEST_QUESTION_APPROVED' }, async (tx, first, second, t, actor) => {
      if (first.status === 'AWAITING_SECOND') throw qmErrors.decisionRequired();
      this.expect(first, ['SUBMITTED', 'UNDER_REVIEW'], dto, t);
      if (second && !secondFinished(second.status)) throw qmErrors.decisionRequired();
      const a = await this.latestSubmitted(tx, first.id);
      await tx.testQuestionDecision.create({ data: { id: randomUUID(), taskId: first.id, cycle: null, source: 'APPROVED_AS_MARKED', marks: a.version.marks, sourceVersionId: a.version.id, decidedById: actor.id, decidedAt: t } });
      await tx.testQuestionAssessment.update({ where: { id: a.id }, data: { status: 'APPROVED', updatedAt: t } });
      await tx.testQuestionTask.update({ where: { id: first.id }, data: { status: 'APPROVED', reviewHoldById: null, reviewHoldUntil: null, updatedAt: t } });
      await taskEvent(tx, t, actor, first.id, 'APPROVED', { from: first.status, to: 'APPROVED', meta: { marks: a.version.marks, source: 'APPROVED_AS_MARKED' } });
      await projectPapers(tx, [first.submissionId], actor, t, { markerId: actor.id });
    });
    return this.taskDetail(testId, taskId, user);
  }

  async returnTask(testId: string, taskId: string, dto: { reason: string; expectedStatus?: string; cycleSeen?: number }, user: AuthUser) {
    if (!dto.reason || dto.reason.trim().length < 3) throw qmErrors.reasonRequired();
    const reason = dto.reason.trim();
    const test = await this.questionTest(testId, user);
    const ref = await this.taskOf(testId, taskId);
    await this.review(testId, taskId, user, { audit: 'TEST_QUESTION_RETURNED' }, async (tx, first, second, t, actor, notices) => {
      const target = ref.round === 'SECOND' ? second : first;
      if (!target || target.id !== taskId) throw qmErrors.taskChanged({ reason: 'cycle-changed' });
      if (target.round === 'FIRST' && first.status === 'AWAITING_SECOND') throw qmErrors.decisionRequired();
      if (target.round === 'FIRST') this.expect(first, ['SUBMITTED', 'UNDER_REVIEW'], dto, t);
      else if (effectiveStatus(target, t) !== 'SUBMITTED') throw qmErrors.taskChanged({ status: target.status });
      if (target.round === 'FIRST' && second && !secondFinished(second.status)) throw qmErrors.decisionRequired();
      const a = await this.latestSubmitted(tx, target.id);
      await tx.testQuestionAssessment.update({ where: { id: a.id }, data: { status: 'RETURNED', updatedAt: t } });
      await tx.testQuestionTask.update({ where: { id: target.id }, data: { status: 'RETURNED', reservedForId: a.markerId, needsReassignment: false, reviewHoldById: null, reviewHoldUntil: null, updatedAt: t } });
      await taskEvent(tx, t, actor, target.id, 'RETURNED', { from: target.status, to: 'RETURNED', cycle: target.cycle, reason, meta: { markerId: a.markerId } });
      await this.notifyCoach(tx, test, a.markerId, DecisionEvents.TestMarkingReturned, `qm-returned:${target.id}:${t.getTime()}`, notices);
      await projectPapers(tx, [first.submissionId], actor, t);
    });
    return this.taskDetail(testId, taskId, user);
  }

  async requestSecond(testId: string, taskId: string, dto: { coachId?: string; reason?: string; cycleSeen?: number }, user: AuthUser) {
    let secondId = '';
    await this.review(testId, taskId, user, { audit: 'TEST_QUESTION_SECOND_REQUESTED' }, async (tx, first, _second, t, actor) => {
      if (first.round !== 'FIRST') throw qmErrors.taskNotFound();
      this.expect(first, ['SUBMITTED', 'UNDER_REVIEW'], dto, t);
      const cycle = first.currentCycle + 1;
      await tx.testQuestionTask.update({ where: { id: first.id }, data: { status: 'AWAITING_SECOND', currentCycle: cycle, reviewHoldById: null, reviewHoldUntil: null, updatedAt: t } });
      secondId = randomUUID();
      await tx.testQuestionTask.create({ data: { id: secondId, submissionId: first.submissionId, questionId: first.questionId, round: 'SECOND', cycle, firstTaskId: first.id, versionId: first.versionId, status: 'NOT_STARTED', createdAt: t, updatedAt: t } });
      await taskEvent(tx, t, actor, first.id, 'SECOND_REQUESTED', { from: first.status, to: 'AWAITING_SECOND', cycle, reason: dto.reason?.trim() || null, meta: { secondTaskId: secondId } });
      await projectPapers(tx, [first.submissionId], actor, t);
    });
    if (dto.coachId) {
      // The named coach: the same claim transaction as any assignment (limit, authorisation, first-marker exclusion).
      await this.assign(testId, secondId, { coachId: dto.coachId, reason: dto.reason?.trim() || 'Second assessment' }, user);
    }
    return this.taskDetail(testId, taskId, user);
  }

  async cancelSecond(testId: string, taskId: string, dto: { reason: string }, user: AuthUser) {
    if (!dto.reason || dto.reason.trim().length < 3) throw qmErrors.reasonRequired();
    await this.review(testId, taskId, user, { audit: 'TEST_QUESTION_SECOND_CANCELLED', coachLocks: (_f, s) => (s?.holderId ? [s.holderId] : []) }, async (tx, first, second, t, actor) => {
      if (first.status !== 'AWAITING_SECOND' || !second) throw qmErrors.taskChanged({ status: first.status });
      if (!['NOT_STARTED', 'IN_PROGRESS', 'RETURNED'].includes(second.status)) throw qmErrors.taskChanged({ secondStatus: second.status });
      if (second.status === 'IN_PROGRESS') await endCurrentClaim(tx, second, t, actor, 'CANCELLED', { expectCoach: second.holderId!, unreserve: true });
      const open = await tx.testQuestionAssessment.findFirst({ where: { taskId: second.id, status: { in: ['DRAFT', 'RETURNED'] } }, select: { id: true } });
      if (open) await tx.testQuestionAssessment.update({ where: { id: open.id }, data: { status: 'ABANDONED', updatedAt: t } });
      await tx.testQuestionTask.update({ where: { id: second.id }, data: { status: 'CANCELLED', reservedForId: null, needsReassignment: false, updatedAt: t } });
      await tx.testQuestionTask.update({ where: { id: first.id }, data: { status: 'SUBMITTED', updatedAt: t } });
      await taskEvent(tx, t, actor, second.id, 'SECOND_CANCELLED', { to: 'CANCELLED', cycle: second.cycle, reason: dto.reason.trim() });
      await taskEvent(tx, t, actor, first.id, 'SECOND_CANCELLED', { from: 'AWAITING_SECOND', to: 'SUBMITTED', cycle: second.cycle, reason: dto.reason.trim() });
      await projectPapers(tx, [first.submissionId], actor, t);
    });
    return this.taskDetail(testId, taskId, user);
  }

  async decide(testId: string, taskId: string, dto: { source: 'FIRST' | 'SECOND' | 'ADJUSTED'; marks?: number; reason: string; cycleSeen?: number }, user: AuthUser) {
    if (!dto.reason || dto.reason.trim().length < 3) throw qmErrors.reasonRequired();
    await this.review(testId, taskId, user, { audit: 'TEST_QUESTION_DECIDED' }, async (tx, first, second, t, actor) => {
      this.expect(first, ['AWAITING_SECOND'], dto, t);
      if (!second || second.status !== 'SUBMITTED') throw qmErrors.secondNotSubmitted();
      const q = await tx.testQuestion.findUniqueOrThrow({ where: { id: first.questionId }, select: { maxMarks: true } });
      let marks: number;
      let sourceVersionId: string | null = null;
      let chosenAssessment: string | null = null;
      if (dto.source === 'ADJUSTED') {
        if (!validMarks(dto.marks ?? undefined, q.maxMarks) || dto.marks === undefined || dto.marks === null) throw qmErrors.marksInvalid(q.maxMarks);
        marks = dto.marks;
      } else {
        const a = await this.latestSubmitted(tx, dto.source === 'FIRST' ? first.id : second.id);
        marks = a.version.marks; sourceVersionId = a.version.id; chosenAssessment = a.id;
      }
      await tx.testQuestionDecision.create({ data: { id: randomUUID(), taskId: first.id, cycle: second.cycle, source: dto.source, marks, sourceVersionId, reason: dto.reason.trim(), decidedById: actor.id, decidedAt: t } });
      if (chosenAssessment) await tx.testQuestionAssessment.update({ where: { id: chosenAssessment }, data: { status: 'APPROVED', updatedAt: t } });
      await tx.testQuestionTask.update({ where: { id: second.id }, data: { status: 'CLOSED', updatedAt: t } });
      await tx.testQuestionTask.update({ where: { id: first.id }, data: { status: 'APPROVED', updatedAt: t } });
      await taskEvent(tx, t, actor, first.id, 'DECIDED', { from: 'AWAITING_SECOND', to: 'APPROVED', cycle: second.cycle, reason: dto.reason.trim(), meta: { source: dto.source, marks } });
      await taskEvent(tx, t, actor, second.id, 'CLOSED', { from: 'SUBMITTED', to: 'CLOSED', cycle: second.cycle });
      await projectPapers(tx, [first.submissionId], actor, t, { markerId: actor.id });
    });
    return this.taskDetail(testId, taskId, user);
  }

  async reopen(testId: string, taskId: string, dto: { reason: string; to: 'RETURNED' | 'SUBMITTED' }, user: AuthUser) {
    if (!dto.reason || dto.reason.trim().length < 3) throw qmErrors.reasonRequired();
    const reason = dto.reason.trim();
    const test = await this.questionTest(testId, user);
    await this.review(testId, taskId, user, { audit: 'TEST_QUESTION_REOPENED' }, async (tx, first, _second, t, actor, notices) => {
      this.expect(first, ['APPROVED'], {}, t);
      const paper = await tx.testSubmission.findUniqueOrThrow({ where: { id: first.submissionId }, select: { status: true, publicationId: true, studentId: true, finalMarkingId: true } });
      const current = await tx.testQuestionDecision.findFirst({ where: { taskId: first.id, supersededAt: null }, select: { id: true, sourceVersionId: true } });
      if (current) await tx.testQuestionDecision.update({ where: { id: current.id }, data: { supersededAt: t, supersededById: actor.id, supersedeReason: reason } });
      // The FIRST assessment to reopen: the latest submitted or approved one.
      const a = await tx.testQuestionAssessment.findFirst({ where: { taskId: first.id, status: { in: ['APPROVED', 'SUBMITTED'] } }, orderBy: { updatedAt: 'desc' }, select: { id: true, markerId: true } });
      if (!a) throw qmErrors.taskChanged({ reason: 'no-assessment' });
      await tx.testQuestionAssessment.update({ where: { id: a.id }, data: { status: dto.to === 'RETURNED' ? 'RETURNED' : 'SUBMITTED', updatedAt: t } });
      await tx.testQuestionTask.update({ where: { id: first.id }, data: { status: dto.to, ...(dto.to === 'RETURNED' ? { reservedForId: a.markerId, needsReassignment: false } : {}), updatedAt: t } });
      await taskEvent(tx, t, actor, first.id, 'REOPENED', { from: 'APPROVED', to: dto.to, reason, meta: { supersededDecision: current?.id ?? null } });
      const fromPaper = paper.status;
      const projected = await projectPapers(tx, [first.submissionId], actor, t);
      if (fromPaper === 'PUBLISHED' && paper.publicationId) {
        // G6, as UNLOCK today: the paper-level review record, the withdrawal, and the notices (once).
        const review = await tx.testReview.create({ data: { submissionId: first.submissionId, action: REVIEW_UNLOCKED, markingId: paper.finalMarkingId, comment: reason, fromStatus: 'PUBLISHED', toStatus: projected.get(first.submissionId) as never, actorId: actor.id, actorRole: actor.role, createdAt: t }, select: { id: true } });
        const w = await tx.testResultWithdrawal.create({ data: { submissionId: first.submissionId, publicationId: paper.publicationId, reviewId: review.id, withdrawnById: actor.id, actorRole: actor.role, reason, createdAt: t }, select: { id: true } });
        await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'TEST_RESULT_WITHDRAWN', entity: 'TestSubmission', entityId: first.submissionId, metadata: { testId, withdrawalId: w.id, publicationId: paper.publicationId, reason } }, tx);
        const students = await activeStudents(tx, [paper.studentId]);
        const teachers = await schoolTeachersOf(tx, [paper.studentId]);
        notices.push(...await this.notices.enqueueMany(tx, resultNotices(DecisionEvents.TestResultWithdrawn, w.id, { id: test.id, title: test.title, subjectName: test.discipline.name }, students, teachers)));
      }
      if (dto.to === 'RETURNED') await this.notifyCoach(tx, test, a.markerId, DecisionEvents.TestMarkingReturned, `qm-reopened:${first.id}:${t.getTime()}`, notices);
    });
    return this.taskDetail(testId, taskId, user);
  }

  // ── Progress and history ─────────────────────────────────────────────────────────────────────────────────────────

  async overview(testId: string, user: AuthUser) {
    this.marker.assertEnabled();   // switch off: 404 FEATURE_DISABLED like every question route (rollback level 1)
    await this.tests.loadInScope(testId, user);
    const test = await this.prisma.test.findUniqueOrThrow({ where: { id: testId }, select: { id: true, title: true, markingMode: true, discipline: { select: { name: true } }, _count: { select: { questions: true, submissions: true } } } });
    const [started] = await this.prisma.$queryRaw<Array<{ started: boolean }>>`SELECT question_marking_started(${testId}) AS "started"`;
    return { test: { id: test.id, title: test.title, subject: test.discipline.name, markingMode: test.markingMode, questions: test._count.questions, papers: test._count.submissions }, modeLocked: started.started, enabled: true };
  }

  async progress(testId: string, user: AuthUser) {
    await this.questionTest(testId, user);
    const tasks = await this.prisma.$queryRaw<Array<{ submissionId: string; order: number; round: string; status: string; holderId: string | null; lockExpiresAt: Date | null; reservedForId: string | null; needsReassignment: boolean; expired: boolean; canReserved: boolean | null }>>`
      SELECT t."submissionId", q."order", t."round"::text AS "round", t."status"::text AS "status", t."holderId", t."lockExpiresAt", t."reservedForId", t."needsReassignment",
             (t."status" = 'IN_PROGRESS' AND t."lockExpiresAt" < clock_timestamp()) AS "expired",
             CASE WHEN t."reservedForId" IS NULL THEN NULL ELSE can_mark_subject(t."reservedForId", te."disciplineId") END AS "canReserved"
        FROM "TestQuestionTask" t JOIN "TestQuestion" q ON q."id" = t."questionId" JOIN "TestSubmission" s ON s."id" = t."submissionId" JOIN "Test" te ON te."id" = s."testId"
       WHERE s."testId" = ${testId}`;
    const first = tasks.filter((x) => x.round === 'FIRST');
    const byStatus = (rows: typeof tasks) => rows.reduce<Record<string, number>>((m, r) => { const k = r.expired ? 'EXPIRED' : r.status; m[k] = (m[k] ?? 0) + 1; return m; }, {});
    const papers = new Map<string, TaskStatus[]>();
    for (const r of first) papers.set(r.submissionId, [...(papers.get(r.submissionId) ?? []), r.status as TaskStatus]);
    const paperStates = [...papers.values()].reduce<Record<string, number>>((m, s) => { const k = paperProgress(s); m[k] = (m[k] ?? 0) + 1; return m; }, {});
    const questions = await this.prisma.testQuestion.findMany({ where: { testId }, orderBy: { order: 'asc' }, select: { order: true, maxMarks: true, _count: { select: { qmMarkers: { where: { endedAt: null } } } } } });
    const coachRows = await this.prisma.$queryRaw<Array<{ id: string; firstName: string; lastName: string; holding: number; submitted: number; approved: number }>>`
      SELECT u."id", u."firstName", u."lastName",
             count(*) FILTER (WHERE t."status" = 'IN_PROGRESS' AND t."holderId" = u."id")::int AS "holding",
             count(DISTINCT a."id") FILTER (WHERE a."status" IN ('SUBMITTED', 'APPROVED'))::int AS "submitted",
             count(DISTINCT a."id") FILTER (WHERE a."status" = 'APPROVED')::int AS "approved"
        FROM "User" u
        JOIN "TestQuestionAssessment" a ON a."markerId" = u."id"
        JOIN "TestQuestionTask" t ON t."id" = a."taskId"
        JOIN "TestSubmission" s ON s."id" = t."submissionId"
       WHERE s."testId" = ${testId}
       GROUP BY u."id" ORDER BY "submitted" DESC, u."lastName"`;
    return {
      papers: { total: papers.size, ...paperStates, fullyApproved: paperStates.FULLY_APPROVED ?? 0 },
      tasks: { total: first.length, byStatus: byStatus(first), second: byStatus(tasks.filter((x) => x.round === 'SECOND')) },
      questions: questions.map((q) => ({ order: q.order, maxMarks: q.maxMarks, coaches: q._count.qmMarkers, unassigned: q._count.qmMarkers === 0, byStatus: byStatus(first.filter((x) => x.order === q.order)) })),
      needsReassignment: first.filter((x) => x.needsReassignment || x.canReserved === false).length,
      expiredClaims: tasks.filter((x) => x.expired).length,
      coaches: coachRows,
    };
  }

  async history(testId: string, q: { taskId?: string; page?: number; limit?: number }, user: AuthUser) {
    await this.questionTest(testId, user);
    const page = q.page ?? 1;
    const limit = Math.min(q.limit ?? 50, 200);
    const where = { task: { submission: { testId } }, ...(q.taskId && { OR: [{ taskId: q.taskId }, { task: { firstTaskId: q.taskId } }] }) };
    const [rows, total] = await Promise.all([
      this.prisma.testTaskEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit, select: { id: true, taskId: true, action: true, fromStatus: true, toStatus: true, cycle: true, actorRole: true, reason: true, meta: true, createdAt: true, actor: { select: { id: true, firstName: true, lastName: true } }, task: { select: { round: true, cycle: true, question: { select: { order: true } }, submission: { select: { publicCode: true } } } } } }),
      this.prisma.testTaskEvent.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  // ── Super Admin corrections (QUESTION mode; reason; audited; history kept) ─────────────────────────────────────

  private superAdmin(user: AuthUser) {
    if (user.role !== 'SUPER_ADMIN') throw new AppError(HttpStatus.FORBIDDEN, 'SUPER_ADMIN_ONLY', 'Only a Super Administrator can correct a test after students have submitted.');
  }

  async correctWording(testId: string, questionId: string, dto: { prompt: string; reason: string }, user: AuthUser) {
    this.actor(user); this.superAdmin(user);
    await this.questionTest(testId, user);
    if (!dto.reason || dto.reason.trim().length < 3) throw qmErrors.reasonRequired();
    if (!dto.prompt?.trim()) throw new AppError(HttpStatus.BAD_REQUEST, 'PROMPT_REQUIRED', 'Give the corrected wording.');
    await this.prisma.$transaction(async (tx) => {
      await lockTest(tx, testId);
      const q = await tx.testQuestion.findFirst({ where: { id: questionId, testId }, select: { id: true, prompt: true, promptVersion: true, updatedAt: true } });
      if (!q) throw new AppError(HttpStatus.NOT_FOUND, 'QUESTION_NOT_FOUND', 'This question is not part of the test.');
      const t = await lockedNow(tx);
      await tx.$executeRaw`SELECT set_config('rof.question_wording_correction', 'on', true)`;
      await tx.testQuestionPromptHistory.create({ data: { id: randomUUID(), questionId, version: q.promptVersion, prompt: q.prompt, validFrom: null, validTo: t, changedById: user.id, reason: dto.reason.trim() } });
      await tx.testQuestion.update({ where: { id: questionId }, data: { prompt: dto.prompt.trim(), promptVersion: q.promptVersion + 1 } });
      await tx.$executeRaw`SELECT set_config('rof.question_wording_correction', '', true)`;
      await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'TEST_QUESTION_WORDING_CORRECTED', entity: 'TestQuestion', entityId: questionId, metadata: { testId, fromVersion: q.promptVersion, reason: dto.reason.trim() } }, tx);
    }, REVIEW_TX);
    return this.markers(testId, user);
  }

  async correctStructure(testId: string, dto: { maxMarks?: number; questions: Array<{ id: string; order: number; maxMarks: number }>; reason: string }, user: AuthUser) {
    this.actor(user); this.superAdmin(user);
    await this.tests.loadInScope(testId, user);
    if (!dto.reason || dto.reason.trim().length < 3) throw qmErrors.reasonRequired();
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      const [s] = await tx.$queryRaw<Array<{ started: boolean }>>`SELECT question_marking_started(${testId}) AS "started"`;
      if (s.started) throw qmErrors.structureFrozen();
      const current = await tx.testQuestion.findMany({ where: { testId }, select: { id: true } });
      const ids = new Set(current.map((x) => x.id));
      if (dto.questions.length !== ids.size || dto.questions.some((x) => !ids.has(x.id))) throw new AppError(HttpStatus.BAD_REQUEST, 'QUESTIONS_MISMATCH', 'List every question of the test once.');
      const orders = dto.questions.map((x) => x.order);
      if (new Set(orders).size !== orders.length || orders.some((o) => !Number.isInteger(o) || o < 1)) throw new AppError(HttpStatus.BAD_REQUEST, 'ORDER_INVALID', 'Number the questions 1, 2, 3 … with no repeats.');
      const max = dto.maxMarks ?? test.maxMarks;
      const sum = dto.questions.reduce((a, x) => a + x.maxMarks, 0);
      if (dto.questions.some((x) => !Number.isInteger(x.maxMarks) || x.maxMarks < 1) || sum !== max) throw new AppError(HttpStatus.BAD_REQUEST, 'MARKS_DO_NOT_ADD_UP', `The question marks must add up to the test maximum (${max}).`, { sum, max });
      await tx.$executeRaw`SELECT set_config('rof.question_structure_correction', 'on', true)`;
      // Two passes avoid the (test, order) unique clash while orders swap.
      for (const [i, x] of dto.questions.entries()) await tx.testQuestion.update({ where: { id: x.id }, data: { order: 10_000 + i } });
      for (const x of dto.questions) await tx.testQuestion.update({ where: { id: x.id }, data: { order: x.order, maxMarks: x.maxMarks } });
      if (max !== test.maxMarks) await tx.test.update({ where: { id: testId }, data: { maxMarks: max } });
      await tx.$executeRaw`SELECT set_config('rof.question_structure_correction', '', true)`;
      await this.audit.log({ actorId: user.id, actorRole: user.role, action: 'TEST_STRUCTURE_CORRECTED', entity: 'Test', entityId: testId, metadata: { reason: dto.reason.trim(), maxMarks: max, questions: dto.questions } }, tx);
    }, REVIEW_TX);
    return this.overview(testId, user);
  }

  // ── Notifications (blind: the test and a count, never a student) ────────────────────────────────────────────────

  private async notifyCoach(tx: Tx, test: { title: string; disciplineId: string }, coachId: string, type: typeof DecisionEvents.TestMarkingAssigned | typeof DecisionEvents.TestMarkingReturned, dedupeKey: string, notices: Notices) {
    const coach = await tx.user.findUniqueOrThrow({ where: { id: coachId }, select: { id: true, email: true, firstName: true, activatedAt: true, accountStatus: true } });
    const subject = await tx.discipline.findUniqueOrThrow({ where: { id: test.disciplineId }, select: { name: true } });
    if (coach.accountStatus !== 'ACTIVE') return;
    notices.push(await this.notices.enqueue(tx, {
      type, dedupeKey, recipient: { userId: coach.id, email: coach.email, firstName: coach.firstName },
      entity: { type: 'Test', id: dedupeKey }, payload: { activated: coach.activatedAt !== null, testTitle: test.title, subjectName: subject.name, count: 1 },
    }));
  }
}

/** UNDER_REVIEW whose 15-minute hold lapsed counts as SUBMITTED (informational hold only). */
function effectiveStatus(task: TaskRow, t: Date): TaskStatus {
  return task.status === 'UNDER_REVIEW' && task.reviewHoldUntil && task.reviewHoldUntil.getTime() < t.getTime() ? 'SUBMITTED' : task.status;
}

/**
 * The current cycle's second assessment no longer stands in the way of approving or returning the FIRST assessment:
 * cancelled, or CLOSED by a decision that a reopen has since superseded (review 2026-11-28: after reopening a decided
 * question, Approve and Return answered DECISION_REQUIRED and Decide was refused too — nothing could move it).
 */
function secondFinished(status: string): boolean {
  return status === 'CANCELLED' || status === 'CLOSED';
}

function allowedActions(first: TaskStatus, second: TaskStatus | undefined, role: string) {
  const reviewable = first === 'SUBMITTED' || first === 'UNDER_REVIEW';
  return {
    approve: reviewable && (!second || secondFinished(second)),
    return: reviewable && (!second || secondFinished(second)),
    requestSecond: reviewable,
    cancelSecond: first === 'AWAITING_SECOND' && !!second && ['NOT_STARTED', 'IN_PROGRESS', 'RETURNED'].includes(second),
    returnSecond: first === 'AWAITING_SECOND' && second === 'SUBMITTED',
    decide: first === 'AWAITING_SECOND' && second === 'SUBMITTED' && role === 'HEAD_COACH',
    reopen: first === 'APPROVED',
    assign: first === 'NOT_STARTED' || first === 'IN_PROGRESS' || first === 'RETURNED',
    release: first === 'IN_PROGRESS',
  };
}
