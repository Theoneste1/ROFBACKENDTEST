/**
 * Test Management (WS3, Phase 3): distribution to markers and review — Administrators (every subject) and the subject's
 * Head Coaches (TestsService.loadInScope; another subject: 403 SCOPE_FORBIDDEN). They see identity; markers never do
 * (test-marker.service.ts).
 *
 * Distribution (tests.distribute)
 *   Only to ACTIVE coaches with an ACTIVE marker authorisation for the subject (an interest never grants it). Only
 *   submissions that may be marked (G5): strictly after the latest applicable deadline — the test's closesAt and every
 *   active extension that could still let someone submit for that student (whole test, the student's own, any teacher
 *   who may submit for them), by database time. Automatic distribution shares the unassigned, markable submissions
 *   evenly (each to the coach with the fewest on this test); manual assignment names submissions and a coach;
 *   reassignment ends the current assignment (who, when, why) and starts another (a marking already submitted stays).
 *   All of it under the test's row lock — the same lock submissions (FOR SHARE) and extensions (FOR UPDATE) take — so a
 *   submission or an extension can never slip in between the deadline check and the assignment.
 *
 * Review (tests.review; choosing the mark: tests.adjustMarks — the subject's Head Coach only, G4)
 *   approve (locks), return a marking for correction (comment), request an independent, blind second marking (another
 *   authorised coach, never the first marker), choose the first, second or an adjusted mark (reason), unlock an
 *   approved result (reason). Each decision: the submission row FOR UPDATE, then ONE row of the transition table
 *   (marking-rules.ts), so two simultaneous decisions never both apply — the second gets 409 INVALID_STATUS_TRANSITION
 *   (or SUBMISSION_CHANGED with expectedStatus). A repeated request with the same clientKey returns the first answer.
 *
 * Every write: one transaction with its status history, review record, mark-change log rows and audit entry (TESTS).
 * Lists are paginated and read in a fixed number of queries.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { DecisionEvents } from '../decision-notifications/decision-content.js';
import { DecisionNotificationsService } from '../decision-notifications/decision-notifications.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  ApproveMarkingDto, AssignMarkingDto, ChooseMarkDto, DistributeMarkingDto, ListMarkingSubmissionsQueryDto, MarkingHistoryQueryDto,
  ReassignMarkingDto, RequestSecondMarkingDto, ReturnMarkingDto, UnlockMarkingDto,
} from './dto/marking.dto.js';
import { distributeEvenly, markingEligible, normaliseMarks, transition, type SubmissionStatus } from './marking-rules.js';
import {
  assertCoachesMayMark, assignFirst, changeStatus, lockSubmission, unassignedEligibility, writeMarks, type Actor, type LockedSubmission,
} from './marking-store.js';
import { activeStudents, resultNotices, schoolTeachersOf } from './results-store.js';
import { answerPageName } from './submission-rules.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { TestsService, lockTest } from './tests.service.js';
import { mayMarkWhere } from './marker-reach.js';

type Tx = Prisma.TransactionClient;

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;
/** Distribution of thousands of submissions: one transaction, a few statements; room to wait for the test lock. */
const DISTRIBUTE_TX = { maxWait: 15_000, timeout: 120_000 } as const;
const REVIEW_TX = { maxWait: 15_000, timeout: 30_000 } as const;

const MARKING_SELECT = {
  id: true, kind: true, status: true, totalMarks: true, comment: true, revision: true, submittedAt: true, approvedAt: true,
  createdAt: true, updatedAt: true, assignmentId: true, versionId: true,
  marker: PERSON,
  scores: { select: { questionId: true, marks: true, comment: true } },
} as const satisfies Prisma.TestMarkingSelect;

const submissionNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'SUBMISSION_NOT_FOUND', 'Submission not found for this test.');

@Injectable()
export class TestMarkingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deadlines: TestDeadlineService,
    private readonly tests: TestsService,
    private readonly notices: DecisionNotificationsService,
  ) {}

  // ── Overview and progress (tests.distribute) ──────────────────────────────────

  /**
   * The test's marking at a glance: submissions by status; how many may be distributed now and how many wait for their
   * deadline (G5, with the next moment one becomes markable); each coach's progress (current assignments: not started,
   * in progress, marked) — every coach authorised for the subject, and anyone still holding assignments. Fixed queries.
   */
  async overview(testId: string, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const test = await this.prisma.test.findUniqueOrThrow({
      where: { id: testId },
      select: { id: true, title: true, status: true, maxMarks: true, closesAt: true, disciplineId: true, discipline: { select: { id: true, code: true, name: true } } },
    });
    const now = await this.deadlines.now();
    const [byStatus, unassigned, progress, authorised] = await Promise.all([
      this.prisma.testSubmission.groupBy({ by: ['status'], where: { testId }, _count: { _all: true } }),
      unassignedEligibility(this.prisma, testId),
      this.prisma.$queryRaw<Array<{ coachId: string; kind: string; assigned: number; notStarted: number; inProgress: number; marked: number }>>`
        SELECT a."coachId", a."kind"::text AS "kind", count(*)::int AS "assigned",
               count(*) FILTER (WHERE m."id" IS NULL)::int AS "notStarted",
               count(*) FILTER (WHERE m."status" IN ('DRAFT', 'RETURNED'))::int AS "inProgress",
               count(*) FILTER (WHERE m."status" IN ('SUBMITTED', 'APPROVED'))::int AS "marked"
          FROM "TestMarkerAssignment" a
          JOIN "TestSubmission" s ON s."id" = a."submissionId"
          LEFT JOIN "TestMarking" m ON m."assignmentId" = a."id"
         WHERE s."testId" = ${testId} AND a."endedAt" IS NULL
         GROUP BY a."coachId", a."kind"`,
      // Every coach who may mark the subject (marker-reach.ts: authorised, or a member of its programme; not restricted).
      this.prisma.user.findMany({ where: { AND: [mayMarkWhere(test.disciplineId), { accountStatus: 'ACTIVE' }] }, select: { id: true } }),
    ]);
    const authorisedIds = new Set(authorised.map((a) => a.id));
    const coachIds = [...new Set([...authorisedIds, ...progress.map((p) => p.coachId)])];
    const coaches = coachIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: coachIds } }, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
          select: { id: true, username: true, firstName: true, lastName: true, accountStatus: true },
        })
      : [];
    const ready = unassigned.filter((r) => markingEligible(now, r.eligibleAt));
    const waiting = unassigned.filter((r) => !markingEligible(now, r.eligibleAt));
    const counts = Object.fromEntries(byStatus.map((b) => [b.status, b._count._all])) as Partial<Record<SubmissionStatus, number>>;
    const sum = (rows: typeof progress, k: 'assigned' | 'notStarted' | 'inProgress' | 'marked') => rows.reduce((a, r) => a + r[k], 0);
    return {
      test: { id: test.id, title: test.title, status: test.status, maxMarks: test.maxMarks, closesAt: test.closesAt, subject: test.discipline },
      now,
      counts: { total: byStatus.reduce((a, b) => a + b._count._all, 0), byStatus: counts },
      distribution: {
        readyToAssign: ready.length,
        waitingForDeadline: waiting.length,
        /** The next moment a waiting submission becomes markable (its latest deadline has passed). */
        nextEligibleAt: waiting.length ? new Date(Math.min(...waiting.map((w) => w.eligibleAt.getTime()))) : null,
      },
      coaches: coaches.map((c) => {
        const mine = progress.filter((p) => p.coachId === c.id);
        const first = mine.filter((p) => p.kind === 'FIRST');
        const second = mine.filter((p) => p.kind === 'SECOND');
        return {
          coach: { id: c.id, username: c.username, firstName: c.firstName, lastName: c.lastName },
          authorised: authorisedIds.has(c.id) && c.accountStatus === 'ACTIVE',
          assigned: sum(mine, 'assigned'), notStarted: sum(mine, 'notStarted'), inProgress: sum(mine, 'inProgress'), marked: sum(mine, 'marked'),
          firstMarkings: sum(first, 'assigned'), secondMarkings: sum(second, 'assigned'),
        };
      }),
    };
  }

  // ── Distribution, assignment, reassignment (tests.distribute) ─────────────────

  /** Share every unassigned, markable submission evenly between the given authorised coaches. */
  async distribute(testId: string, dto: DistributeMarkingDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    await this.paperOnly(testId);
    const actor: Actor = { id: user.id, actorRole: user.role };
    const op = dto.clientKey ?? randomUUID();
    const notices: Array<string | null> = [];
    const result = await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      await assertCoachesMayMark(tx, dto.coachIds, test.disciplineId);
      const now = await this.deadlines.now(tx);
      const unassigned = await unassignedEligibility(tx, testId);
      const ready = unassigned.filter((r) => markingEligible(now, r.eligibleAt));
      const loads = await this.currentLoads(tx, testId, dto.coachIds);
      const plan = distributeEvenly(ready.map((r) => r.id), dto.coachIds.map((id) => ({ id, load: loads.get(id) ?? 0 })));
      const pairs = [...plan].flatMap(([coachId, sids]) => sids.map((submissionId) => ({ submissionId, coachId })));
      await assignFirst(tx, pairs, 'DISTRIBUTION', actor, now, null);
      const perCoach = [...plan].map(([coachId, sids]) => ({ coachId, assigned: sids.length, total: (loads.get(coachId) ?? 0) + sids.length }));
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_MARKING_DISTRIBUTED', entity: 'Test', entityId: testId,
        metadata: {
          subjectId: test.disciplineId, assigned: pairs.length, waitingForDeadline: unassigned.length - ready.length,
          coaches: perCoach, clientKey: dto.clientKey ?? null,
        },
      }, tx);
      await this.notifyAssigned(tx, test, perCoach.filter((c) => c.assigned > 0).map((c) => ({ coachId: c.coachId, count: c.assigned })), op, notices);
      return { assigned: pairs.length, waitingForDeadline: unassigned.length - ready.length, coaches: perCoach };
    }, DISTRIBUTE_TX);
    this.notices.dispatchAfterCommit(notices);
    return result;
  }

  /** Give these submissions (unassigned, markable) to one authorised coach. Already theirs: nothing changes (idempotent). */
  async assign(testId: string, dto: AssignMarkingDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    await this.paperOnly(testId);
    const actor: Actor = { id: user.id, actorRole: user.role };
    const notices: Array<string | null> = [];
    const result = await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      await assertCoachesMayMark(tx, [dto.coachId], test.disciplineId);
      const now = await this.deadlines.now(tx);
      const subs = await tx.testSubmission.findMany({
        where: { id: { in: dto.submissionIds }, testId },
        select: { id: true, status: true, markerAssignments: { where: { kind: 'FIRST', endedAt: null }, select: { coachId: true } } },
      });
      const found = new Map(subs.map((s) => [s.id, s]));
      const missing = dto.submissionIds.filter((id) => !found.has(id));
      if (missing.length) throw new AppError(HttpStatus.NOT_FOUND, 'SUBMISSION_NOT_FOUND', 'Some submissions are not submissions of this test.', { submissionIds: missing });
      const already = subs.filter((s) => s.markerAssignments[0]?.coachId === dto.coachId).map((s) => s.id);
      const others = subs.filter((s) => s.markerAssignments.length && s.markerAssignments[0].coachId !== dto.coachId).map((s) => s.id);
      if (others.length) {
        throw new AppError(HttpStatus.CONFLICT, 'ALREADY_ASSIGNED', 'Some submissions already have a marker: reassign them instead.', { submissionIds: others });
      }
      const todo = subs.filter((s) => s.markerAssignments.length === 0);
      const notSubmitted = todo.filter((s) => s.status !== 'SUBMITTED').map((s) => s.id);
      if (notSubmitted.length) {
        throw new AppError(HttpStatus.CONFLICT, 'INVALID_STATUS_TRANSITION', 'Only submitted, unassigned submissions can be assigned.', { submissionIds: notSubmitted });
      }
      const eligibility = new Map((await unassignedEligibility(tx, testId, todo.map((s) => s.id))).map((r) => [r.id, r.eligibleAt]));
      const early = todo.filter((s) => !markingEligible(now, eligibility.get(s.id)!));
      if (early.length) {
        throw new AppError(HttpStatus.CONFLICT, 'NOT_YET_MARKABLE',
          'Marking begins only after the latest deadline that applies to the submission, extensions included.',
          { submissions: early.map((s) => ({ submissionId: s.id, markableAfter: eligibility.get(s.id)!.toISOString() })) });
      }
      const pairs = todo.map((s) => ({ submissionId: s.id, coachId: dto.coachId }));
      await assignFirst(tx, pairs, 'MANUAL', actor, now, dto.reason ?? null);
      if (pairs.length) {
        await this.audit.log({
          actorId: user.id, actorRole: user.role, action: 'TEST_MARKER_ASSIGNED', entity: 'Test', entityId: testId,
          metadata: { subjectId: test.disciplineId, coachId: dto.coachId, submissionIds: pairs.map((p) => p.submissionId), reason: dto.reason ?? null },
        }, tx);
        await this.notifyAssigned(tx, test, [{ coachId: dto.coachId, count: pairs.length }], `manual:${randomUUID()}`, notices);
      }
      return { assigned: pairs.length, alreadyAssigned: already.length };
    }, REVIEW_TX);
    this.notices.dispatchAfterCommit(notices);
    return result;
  }

  /**
   * Another authorised coach takes over a FIRST (default) or SECOND marking that is not submitted yet: the current
   * assignment ends (who, when, why) and a new one starts; the previous marker's draft stays in the history and is never
   * shown to the new marker. A SECOND marker is never the first marker (and vice versa).
   */
  async reassign(testId: string, submissionId: string, dto: ReassignMarkingDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    await this.paperOnly(testId);
    const actor: Actor = { id: user.id, actorRole: user.role };
    const kind = dto.kind ?? 'FIRST';
    const notices: Array<string | null> = [];
    await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      const sub = await lockSubmission(tx, { id: submissionId, testId });
      if (!sub) throw submissionNotFound();
      const now = await this.deadlines.now(tx);
      const assignments = await tx.testMarkerAssignment.findMany({
        where: { submissionId, endedAt: null }, select: { id: true, kind: true, coachId: true, marking: { select: { status: true } } },
      });
      const current = assignments.find((a) => a.kind === kind);
      if (!current) throw new AppError(HttpStatus.CONFLICT, 'NOT_ASSIGNED', `This submission has no current ${kind.toLowerCase()} marker.`);
      if (current.marking && (current.marking.status === 'SUBMITTED' || current.marking.status === 'APPROVED')) {
        throw new AppError(HttpStatus.CONFLICT, 'MARKING_ALREADY_SUBMITTED', 'This marking was already submitted: return it for correction instead.');
      }
      if (current.coachId === dto.coachId) throw new AppError(HttpStatus.CONFLICT, 'SAME_COACH', 'This coach already marks this submission.');
      const other = assignments.find((a) => a.kind !== kind);
      if (other?.coachId === dto.coachId || (kind === 'SECOND' && (await this.everFirstMarker(tx, submissionId, dto.coachId)))) {
        throw new AppError(HttpStatus.CONFLICT, 'SAME_MARKER', 'The second marking must be by another coach than the first.');
      }
      await assertCoachesMayMark(tx, [dto.coachId], test.disciplineId);
      await changeStatus(tx, sub, kind === 'FIRST' ? 'REASSIGN_FIRST' : 'REASSIGN_SECOND', actor, now, dto.reason);
      await tx.testMarkerAssignment.update({ where: { id: current.id }, data: { endedAt: now, endedById: user.id, endReason: dto.reason } });
      const created = await tx.testMarkerAssignment.create({
        data: { submissionId, kind, coachId: dto.coachId, assignedById: user.id, assignedAt: now, method: 'REASSIGNMENT', reason: dto.reason },
        select: { id: true },
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_MARKER_REASSIGNED', entity: 'TestSubmission', entityId: submissionId,
        metadata: {
          testId, subjectId: test.disciplineId, kind, fromCoachId: current.coachId, toCoachId: dto.coachId,
          endedAssignmentId: current.id, assignmentId: created.id, reason: dto.reason, status: sub.status,
        },
      }, tx);
      await this.notifyAssigned(tx, test, [{ coachId: dto.coachId, count: 1 }], `assignment:${created.id}`, notices);
    }, REVIEW_TX);
    this.notices.dispatchAfterCommit(notices);
    return this.detail(testId, submissionId, user);
  }

  // ── Review list and detail (tests.review) ──────────────────────────────────────

  /** Submissions with identity, status, markers and marks (first, second, final). Filters: status, coach, q. Paginated. */
  async list(testId: string, q: ListMarkingSubmissionsQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.TestSubmissionWhereInput = {
      testId,
      ...(q.status && { status: q.status }),
      ...(q.coachId && { markerAssignments: { some: { coachId: q.coachId, endedAt: null } } }),
      ...(contains && { OR: [
        { publicCode: contains },
        { student: { OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] } },
      ] }),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total, byStatus] = await this.prisma.$transaction([
      this.prisma.testSubmission.findMany({
        where, skip, take, orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }, { id: 'asc' }],
        select: {
          id: true, publicCode: true, status: true, updatedAt: true, finalMarkingId: true,
          student: { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } },
          markerAssignments: { where: { endedAt: null }, select: { kind: true, coach: PERSON } },
          markings: { select: { id: true, kind: true, status: true, totalMarks: true, assignment: { select: { endedAt: true } } } },
        },
      }),
      this.prisma.testSubmission.count({ where }),
      this.prisma.testSubmission.groupBy({ by: ['status'], where: { testId }, orderBy: { status: 'asc' }, _count: { _all: true } }),
    ]);
    const now = await this.deadlines.now();
    const waitingIds = rows.filter((r) => r.status === 'SUBMITTED').map((r) => r.id);
    const eligibility = waitingIds.length ? new Map((await unassignedEligibility(this.prisma, testId, waitingIds)).map((r) => [r.id, r.eligibleAt])) : new Map<string, Date>();
    const out = paginated(rows.map((r) => {
      /** The current marker's marking of this kind: its status, and its total once submitted (a draft's total is not shown). */
      const latest = (kind: 'FIRST' | 'SECOND') => {
        const m = r.markings.find((x) => x.kind === kind && x.assignment?.endedAt === null);
        return m ? { status: m.status, totalMarks: m.status === 'SUBMITTED' || m.status === 'APPROVED' ? m.totalMarks : null } : null;
      };
      const final = r.markings.find((m) => m.id === r.finalMarkingId);
      const eligibleAt = eligibility.get(r.id) ?? null;
      return {
        id: r.id, publicCode: r.publicCode, status: r.status, updatedAt: r.updatedAt, student: r.student,
        firstMarker: r.markerAssignments.find((a) => a.kind === 'FIRST')?.coach ?? null,
        secondMarker: r.markerAssignments.find((a) => a.kind === 'SECOND')?.coach ?? null,
        first: latest('FIRST'), second: latest('SECOND'),
        final: final ? { kind: final.kind, totalMarks: final.totalMarks } : null,
        /** SUBMITTED only: whether it may be assigned now (G5) and from when. */
        markable: eligibleAt ? markingEligible(now, eligibleAt) : null,
        markableAfter: eligibleAt,
      };
    }), total, page, limit);
    return { ...out, counts: Object.fromEntries(byStatus.map((b) => [b.status, (b._count as { _all: number })._all])) };
  }

  /**
   * One submission for review: the student (identity), the answer (current version and its pages), every marking side by
   * side (first, second, adjustments: marks per question and comments, marker, status), every assignment (who assigned,
   * reassignments with reasons), every review decision, the status history and the mark-change log.
   */
  async detail(testId: string, submissionId: string, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const sub = await this.prisma.testSubmission.findFirst({
      where: { id: submissionId, testId },
      select: {
        id: true, publicCode: true, status: true, finalMarkingId: true, versionCount: true, updatedAt: true,
        student: { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } },
        test: { select: { id: true, title: true, maxMarks: true, discipline: { select: { id: true, code: true, name: true } },
          questions: { orderBy: { order: 'asc' }, select: { id: true, order: true, prompt: true, maxMarks: true } } } },
        currentVersion: { select: { id: true, number: true, typedAnswer: true, pageCount: true,
          pages: { orderBy: { pageNumber: 'asc' }, select: { pageNumber: true, file: { select: { mimeType: true, size: true } } } } } },
        markerAssignments: { orderBy: { assignedAt: 'asc' }, select: {
          id: true, kind: true, method: true, reason: true, assignedAt: true, endedAt: true, endReason: true,
          coach: PERSON, assignedBy: PERSON, endedBy: PERSON } },
        markings: { orderBy: { createdAt: 'asc' }, select: MARKING_SELECT },
        reviews: { orderBy: { createdAt: 'asc' }, select: {
          id: true, action: true, chosenKind: true, comment: true, fromStatus: true, toStatus: true, actorRole: true, createdAt: true,
          markingId: true, actor: PERSON } },
        statusChanges: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, actorRole: true, reason: true, createdAt: true, actor: PERSON } },
      },
    });
    if (!sub) throw submissionNotFound();
    const changes = await this.prisma.testMarkChange.findMany({
      where: { marking: { submissionId } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, markingId: true, questionId: true, oldMarks: true, newMarks: true, changedByRole: true, reason: true, createdAt: true, changedBy: PERSON },
    });
    const v = sub.currentVersion;
    return {
      id: sub.id, publicCode: sub.publicCode, status: sub.status, finalMarkingId: sub.finalMarkingId, updatedAt: sub.updatedAt,
      student: sub.student,
      test: { id: sub.test.id, title: sub.test.title, maxMarks: sub.test.maxMarks, subject: sub.test.discipline, questions: sub.test.questions },
      answer: v && {
        versionId: v.id, version: v.number, versionCount: sub.versionCount, typedAnswer: v.typedAnswer,
        pages: v.pages.map((p) => ({ page: p.pageNumber, name: answerPageName(p.pageNumber, p.file.mimeType), mimeType: p.file.mimeType, size: p.file.size })),
      },
      markings: sub.markings.map((m) => ({ ...m, final: m.id === sub.finalMarkingId })),
      assignments: sub.markerAssignments.map((a) => ({ ...a, current: a.endedAt === null })),
      reviews: sub.reviews,
      statusHistory: sub.statusChanges,
      markChanges: changes,
      actions: allowedActions(sub.status as SubmissionStatus, sub.markings, sub.markerAssignments),
    };
  }

  /** The test's marking history: status changes, the mark-change log, or the review decisions — newest first. */
  async history(testId: string, q: MarkingHistoryQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const { page, limit, skip, take } = pageArgs(q);
    const subWhere: Prisma.TestSubmissionWhereInput = { testId, ...(q.submissionId && { id: q.submissionId }) };
    const SUB = { select: { id: true, publicCode: true, student: { select: { id: true, firstName: true, lastName: true } } } } as const;
    if (q.type === 'marks') {
      const where: Prisma.TestMarkChangeWhereInput = { marking: { submission: subWhere } };
      const [rows, total] = await this.prisma.$transaction([
        this.prisma.testMarkChange.findMany({
          where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: {
            id: true, oldMarks: true, newMarks: true, changedByRole: true, reason: true, createdAt: true, changedBy: PERSON,
            question: { select: { id: true, order: true, maxMarks: true } },
            marking: { select: { id: true, kind: true, marker: PERSON, submission: SUB } },
          },
        }),
        this.prisma.testMarkChange.count({ where }),
      ]);
      return paginated(rows.map(({ marking, ...c }) => ({ ...c, marking: { id: marking.id, kind: marking.kind, marker: marking.marker }, submission: marking.submission })), total, page, limit);
    }
    if (q.type === 'reviews') {
      const where: Prisma.TestReviewWhereInput = { submission: subWhere };
      const [rows, total] = await this.prisma.$transaction([
        this.prisma.testReview.findMany({
          where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true, action: true, chosenKind: true, comment: true, fromStatus: true, toStatus: true, actorRole: true, createdAt: true, actor: PERSON, submission: SUB },
        }),
        this.prisma.testReview.count({ where }),
      ]);
      return paginated(rows, total, page, limit);
    }
    const where: Prisma.TestSubmissionStatusChangeWhereInput = { submission: subWhere };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.testSubmissionStatusChange.findMany({
        where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, fromStatus: true, toStatus: true, actorRole: true, reason: true, createdAt: true, actor: PERSON, submission: SUB },
      }),
      this.prisma.testSubmissionStatusChange.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  // ── Reviewer decisions (tests.review; choose: tests.adjustMarks) ──────────────

  /**
   * Approve: the final marking (the Head Coach's choice; otherwise the only marking — with a second marking a choice is
   * required: 409 MARK_CHOICE_REQUIRED) becomes APPROVED and the result is locked.
   */
  async approve(testId: string, submissionId: string, dto: ApproveMarkingDto, user: AuthUser) {
    return this.decide(testId, submissionId, dto, user, async (tx, sub, actor, now) => {
      transition('APPROVE', sub.status);
      const markings = await this.submittedMarkings(tx, submissionId);
      const finalId = sub.finalMarkingId ?? (() => {
        if (markings.some((m) => m.kind === 'SECOND')) {
          throw new AppError(HttpStatus.CONFLICT, 'MARK_CHOICE_REQUIRED', 'Two markings exist: the Head Coach chooses the first, the second or an adjusted mark first.');
        }
        const first = markings.find((m) => m.kind === 'FIRST');
        if (!first) throw new AppError(HttpStatus.CONFLICT, 'NOTHING_TO_APPROVE', 'No submitted marking to approve.');
        return first.id;
      })();
      const from = sub.status;
      await changeStatus(tx, sub, 'APPROVE', actor, now, null, { finalMarkingId: finalId });
      await tx.testMarking.update({ where: { id: finalId }, data: { status: 'APPROVED', approvedAt: now } });
      return { review: 'APPROVED' as const, markingId: finalId, from, comment: null, audit: 'TEST_MARKING_APPROVED', meta: { markingId: finalId } };
    });
  }

  /** Return a submitted marking to its marker for correction (mandatory comment); the marker is told once. */
  async returnForCorrection(testId: string, submissionId: string, dto: ReturnMarkingDto, user: AuthUser) {
    const notices: Array<string | null> = [];
    const out = await this.decide(testId, submissionId, dto, user, async (tx, sub, actor, now) => {
      transition('RETURN', sub.status);
      const markings = await this.submittedMarkings(tx, submissionId);
      const markers = markings.filter((m) => m.kind !== 'ADJUSTMENT');
      const kind = dto.kind ?? (markers.length === 1 ? markers[0].kind : null);
      if (!kind) throw new AppError(HttpStatus.BAD_REQUEST, 'KIND_REQUIRED', 'Two markings exist: say which one to return (kind FIRST or SECOND).');
      const target = markers.find((m) => m.kind === kind);
      if (!target) throw new AppError(HttpStatus.CONFLICT, 'NOTHING_TO_RETURN', `No submitted ${kind.toLowerCase()} marking to return.`);
      const from = sub.status;
      await changeStatus(tx, sub, 'RETURN', actor, now, dto.comment, { finalMarkingId: null });
      await tx.testMarking.update({ where: { id: target.id }, data: { status: 'RETURNED' } });
      return {
        review: 'RETURNED' as const, markingId: target.id, from, comment: dto.comment, audit: 'TEST_MARKING_RETURNED',
        meta: { markingId: target.id, kind, coachId: target.markerId },
        after: async (reviewId: string) => {
          const test = await tx.test.findUniqueOrThrow({ where: { id: testId }, select: { title: true, disciplineId: true } });
          await this.notifyCoach(tx, test, target.markerId, DecisionEvents.TestMarkingReturned, `${DecisionEvents.TestMarkingReturned}:${reviewId}`, 1, notices);
        },
      };
    });
    this.notices.dispatchAfterCommit(notices);
    return out;
  }

  /** An independent, blind second marking by another authorised coach (never the first marker); once per submission. */
  async requestSecondMarking(testId: string, submissionId: string, dto: RequestSecondMarkingDto, user: AuthUser) {
    const notices: Array<string | null> = [];
    const out = await this.decide(testId, submissionId, dto, user, async (tx, sub, actor, now) => {
      transition('REQUEST_SECOND_MARKING', sub.status);
      const test = await tx.test.findUniqueOrThrow({ where: { id: testId }, select: { title: true, disciplineId: true } });
      const second = await tx.testMarkerAssignment.findFirst({ where: { submissionId, kind: 'SECOND' }, select: { id: true } });
      if (second) throw new AppError(HttpStatus.CONFLICT, 'SECOND_MARKING_EXISTS', 'A second marking was already requested for this submission.');
      if (await this.everFirstMarker(tx, submissionId, dto.coachId)) {
        throw new AppError(HttpStatus.CONFLICT, 'SAME_MARKER', 'The second marking must be by another coach than the first.');
      }
      await assertCoachesMayMark(tx, [dto.coachId], test.disciplineId);
      const first = (await this.submittedMarkings(tx, submissionId)).find((m) => m.kind === 'FIRST');
      const from = sub.status;
      await changeStatus(tx, sub, 'REQUEST_SECOND_MARKING', actor, now, dto.reason ?? null, { finalMarkingId: null });
      const created = await tx.testMarkerAssignment.create({
        data: { submissionId, kind: 'SECOND', coachId: dto.coachId, assignedById: user.id, assignedAt: now, method: 'SECOND_MARKING', reason: dto.reason ?? null },
        select: { id: true },
      });
      return {
        review: 'SECOND_MARKING_REQUESTED' as const, markingId: first?.id ?? null, from, comment: dto.reason ?? null, audit: 'TEST_SECOND_MARKING_REQUESTED',
        meta: { coachId: dto.coachId, assignmentId: created.id, firstMarkingId: first?.id ?? null },
        after: async () => {
          await this.notifyCoach(tx, test, dto.coachId, DecisionEvents.TestMarkingAssigned, `assignment:${created.id}`, 1, notices);
        },
      };
    });
    this.notices.dispatchAfterCommit(notices);
    return out;
  }

  /**
   * The subject's Head Coach chooses the mark that counts: the first, the second, or ADJUSTED marks entered now (a new
   * ADJUSTMENT marking; each changed mark logged against the marks it replaces). Mandatory reason. Administrators never
   * reach this (tests.adjustMarks is ADMIN_PROHIBITED, G4).
   */
  async choose(testId: string, submissionId: string, dto: ChooseMarkDto, user: AuthUser) {
    return this.decide(testId, submissionId, dto, user, async (tx, sub, actor, now) => {
      const from = sub.status;
      transition('CHOOSE_MARK', sub.status);   // MARKED only — checked before anything is written
      const markings = await this.submittedMarkings(tx, submissionId);
      let chosenId: string;
      if (dto.source === 'ADJUSTMENT') {
        if (!dto.marks) throw new AppError(HttpStatus.BAD_REQUEST, 'MARKS_REQUIRED', 'Give the adjusted marks.');
        if (!sub.currentVersionId) throw new AppError(HttpStatus.CONFLICT, 'NOTHING_TO_APPROVE', 'This submission has no answer.');
        const test = await tx.test.findUniqueOrThrow({
          where: { id: testId }, select: { maxMarks: true, questions: { select: { id: true, order: true, maxMarks: true } } },
        });
        const marks = normaliseMarks(test.questions, test.maxMarks, dto.marks, true);
        // The marks the adjustment replaces: the final ones, else the latest independent marking (second, else first).
        const base = markings.find((m) => m.id === sub.finalMarkingId) ?? markings.find((m) => m.kind === 'SECOND') ?? markings.find((m) => m.kind === 'FIRST');
        const adj = await tx.testMarking.create({
          data: { submissionId, kind: 'ADJUSTMENT', markerId: user.id, versionId: sub.currentVersionId, status: 'DRAFT', createdAt: now, updatedAt: now },
          select: { id: true },
        });
        // The adjustment starts from the marks it replaces, so the log shows old → new per question.
        if (base) {
          await tx.testMarkingScore.createMany({
            data: base.scores.map((s) => ({ id: randomUUID(), markingId: adj.id, questionId: s.questionId, marks: s.marks, comment: s.comment, updatedAt: now })),
          });
          await tx.testMarking.update({ where: { id: adj.id }, data: { totalMarks: base.totalMarks } });
        }
        await writeMarks(tx, adj.id, test.questions.length > 0, marks, actor, now, dto.reason);
        await tx.testMarking.update({ where: { id: adj.id }, data: { status: 'SUBMITTED', submittedAt: now } });
        chosenId = adj.id;
      } else {
        const m = markings.find((x) => x.kind === dto.source);
        if (!m) throw new AppError(HttpStatus.CONFLICT, 'MARKING_NOT_AVAILABLE', `No submitted ${dto.source.toLowerCase()} marking to choose.`);
        chosenId = m.id;
      }
      await changeStatus(tx, sub, 'CHOOSE_MARK', actor, now, dto.reason, { finalMarkingId: chosenId });
      return {
        review: 'MARK_CHOSEN' as const, markingId: chosenId, from, comment: dto.reason, chosenKind: dto.source, audit: 'TEST_MARK_CHOSEN',
        meta: { source: dto.source, markingId: chosenId },
      };
    });
  }

  /**
   * Unlock an approved result (mandatory reason): back to MARKED, the marking back to SUBMITTED (marks unchanged).
   * G6 (Phase 4): unlocking a PUBLISHED result also WITHDRAWS it — it leaves the student's and their teachers' views
   * (publicationId cleared, a TestResultWithdrawal row with the publication, the decision and the reason, audited
   * TEST_RESULT_WITHDRAWN) until it is approved and published again; the student and their school's teachers are told
   * once (same transaction, dedupe key per withdrawal; a replayed request adds nothing).
   */
  async unlock(testId: string, submissionId: string, dto: UnlockMarkingDto, user: AuthUser) {
    const notices: Array<string | null> = [];
    const out = await this.decide(testId, submissionId, dto, user, async (tx, sub, actor, now) => {
      const from = sub.status;
      const finalId = sub.finalMarkingId;
      const publicationId = from === 'PUBLISHED'
        ? (await tx.testSubmission.findUniqueOrThrow({ where: { id: sub.id }, select: { publicationId: true } })).publicationId
        : null;
      await changeStatus(tx, sub, 'UNLOCK', actor, now, dto.reason, from === 'PUBLISHED' ? { publicationId: null, publishedAt: null } : {});
      if (finalId) await tx.testMarking.update({ where: { id: finalId }, data: { status: 'SUBMITTED', approvedAt: null } });
      return {
        review: 'UNLOCKED' as const, markingId: finalId, from, comment: dto.reason, audit: 'TEST_MARKING_UNLOCKED',
        meta: { markingId: finalId, withdrawn: publicationId !== null, publicationId },
        after: publicationId === null ? undefined : async (reviewId: string) => {
          notices.push(...await this.withdrawPublished(tx, testId, sub, publicationId, reviewId, dto.reason, user, now));
        },
      };
    });
    this.notices.dispatchAfterCommit(notices);
    return out;
  }

  /** G6: the withdrawal record, its audit entry, and the notices to the student and their school's teachers (once). */
  private async withdrawPublished(
    tx: Tx, testId: string, sub: LockedSubmission, publicationId: string, reviewId: string, reason: string, user: AuthUser, now: Date,
  ): Promise<string[]> {
    const w = await tx.testResultWithdrawal.create({
      data: { submissionId: sub.id, publicationId, reviewId, withdrawnById: user.id, actorRole: user.role, reason, createdAt: now },
      select: { id: true },
    });
    const test = await tx.test.findUniqueOrThrow({ where: { id: testId }, select: { id: true, title: true, disciplineId: true, discipline: { select: { name: true } } } });
    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'TEST_RESULT_WITHDRAWN', entity: 'TestSubmission', entityId: sub.id,
      metadata: { testId, subjectId: test.disciplineId, withdrawalId: w.id, publicationId, reviewId, reason },
    }, tx);
    const [students, teachers] = await Promise.all([activeStudents(tx, [sub.studentId]), schoolTeachersOf(tx, [sub.studentId])]);
    return this.notices.enqueueMany(tx, resultNotices(DecisionEvents.TestResultWithdrawn, w.id,
      { id: test.id, title: test.title, subjectName: test.discipline.name }, students, teachers));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** Question-level marking (Rev 5.2): a QUESTION-mode test is never distributed or reviewed paper by paper. */
  private async paperOnly(testId: string) {
    const t = await this.prisma.test.findUnique({ where: { id: testId }, select: { markingMode: true } });
    if (t?.markingMode === 'QUESTION') {
      throw new AppError(HttpStatus.CONFLICT, 'WRONG_MARKING_MODE', 'This test is marked question by question. Use the question marking screens for it.', { markingMode: 'QUESTION' });
    }
  }

  /**
   * One reviewer decision: scope, the submission row FOR UPDATE, idempotency (clientKey), the expected status, the step
   * itself, then the review record and the audit entry — one transaction.
   */
  private async decide(
    testId: string, submissionId: string, dto: { clientKey?: string; expectedStatus?: string }, user: AuthUser,
    step: (tx: Tx, sub: LockedSubmission, actor: Actor, now: Date) => Promise<{
      review: 'APPROVED' | 'RETURNED' | 'SECOND_MARKING_REQUESTED' | 'MARK_CHOSEN' | 'UNLOCKED';
      markingId: string | null; from: SubmissionStatus; comment: string | null; chosenKind?: 'FIRST' | 'SECOND' | 'ADJUSTMENT';
      audit: string; meta: Record<string, unknown>; after?: (reviewId: string) => Promise<void>;
    }>,
  ) {
    await this.tests.loadInScope(testId, user);
    await this.paperOnly(testId);
    const actor: Actor = { id: user.id, actorRole: user.role };
    const replayed = await this.prisma.$transaction(async (tx) => {
      const sub = await lockSubmission(tx, { id: submissionId, testId });
      if (!sub) throw submissionNotFound();
      if (dto.clientKey) {
        const again = await tx.testReview.findUnique({ where: { submissionId_clientKey: { submissionId, clientKey: dto.clientKey } }, select: { id: true } });
        if (again) return true;
      }
      if (dto.expectedStatus && dto.expectedStatus !== sub.status) {
        throw new AppError(HttpStatus.CONFLICT, 'SUBMISSION_CHANGED', 'Someone else changed this submission meanwhile; reload it.', { status: sub.status, expected: dto.expectedStatus });
      }
      const now = await this.deadlines.now(tx);
      const r = await step(tx, sub, actor, now);
      const review = await tx.testReview.create({
        data: {
          submissionId, action: r.review, markingId: r.markingId, chosenKind: r.chosenKind ?? null, comment: r.comment,
          fromStatus: r.from, toStatus: sub.status, actorId: user.id, actorRole: user.role, clientKey: dto.clientKey ?? null, createdAt: now,
        },
        select: { id: true },
      });
      const test = await tx.test.findUniqueOrThrow({ where: { id: testId }, select: { disciplineId: true } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: r.audit, entity: 'TestSubmission', entityId: submissionId,
        metadata: { testId, subjectId: test.disciplineId, reviewId: review.id, from: r.from, to: sub.status, comment: r.comment, ...r.meta },
      }, tx);
      await r.after?.(review.id);
      return false;
    }, REVIEW_TX);
    return { ...(await this.detail(testId, submissionId, user)), replayed };
  }

  /** The submitted (or approved) markings of a submission: the current FIRST and SECOND, and every ADJUSTMENT. */
  private async submittedMarkings(tx: Tx, submissionId: string) {
    const rows = await tx.testMarking.findMany({
      where: { submissionId, status: { in: ['SUBMITTED', 'APPROVED'] }, OR: [{ kind: 'ADJUSTMENT' }, { assignment: { endedAt: null } }] },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, markerId: true, totalMarks: true, scores: { select: { questionId: true, marks: true, comment: true } } },
    });
    return rows;
  }

  /** Whether this coach ever held the FIRST marking of the submission (a second marker must be someone else). */
  private async everFirstMarker(tx: Tx, submissionId: string, coachId: string): Promise<boolean> {
    return (await tx.testMarkerAssignment.count({ where: { submissionId, kind: 'FIRST', coachId } })) > 0;
  }

  /** Current assignments on this test per coach (any kind), for an even distribution. */
  private async currentLoads(tx: Tx, testId: string, coachIds: readonly string[]): Promise<Map<string, number>> {
    const rows = await tx.$queryRaw<Array<{ coachId: string; n: number }>>`
      SELECT a."coachId", count(*)::int AS "n" FROM "TestMarkerAssignment" a JOIN "TestSubmission" s ON s."id" = a."submissionId"
       WHERE s."testId" = ${testId} AND a."endedAt" IS NULL AND a."coachId" = ANY(${[...coachIds]}::text[])
       GROUP BY a."coachId"`;
    return new Map(rows.map((r) => [r.coachId, r.n]));
  }

  private async notifyAssigned(
    tx: Tx, test: { title: string; disciplineId: string }, perCoach: Array<{ coachId: string; count: number }>, op: string, notices: Array<string | null>,
  ) {
    for (const c of perCoach) {
      await this.notifyCoach(tx, test, c.coachId, DecisionEvents.TestMarkingAssigned, `${DecisionEvents.TestMarkingAssigned}:${op}:${c.coachId}`, c.count, notices);
    }
  }

  /** Tell a coach once (dedupe key): the test and how many — never a student (blind marking). */
  private async notifyCoach(
    tx: Tx, test: { title: string; disciplineId: string }, coachId: string,
    type: typeof DecisionEvents.TestMarkingAssigned | typeof DecisionEvents.TestMarkingReturned, dedupeKey: string, count: number,
    notices: Array<string | null>,
  ) {
    const [coach, subject] = await Promise.all([
      tx.user.findUniqueOrThrow({ where: { id: coachId }, select: { id: true, email: true, firstName: true, activatedAt: true, accountStatus: true } }),
      tx.discipline.findUniqueOrThrow({ where: { id: test.disciplineId }, select: { name: true } }),
    ]);
    if (coach.accountStatus !== 'ACTIVE') return;
    notices.push(await this.notices.enqueue(tx, {
      type, dedupeKey,
      recipient: { userId: coach.id, email: coach.email, firstName: coach.firstName },
      entity: { type: 'Test', id: dedupeKey },
      payload: { activated: coach.activatedAt !== null, testTitle: test.title, subjectName: subject.name, count },
    }));
  }
}

/** What a reviewer may do now (the frontend shows only these; the server checks again). */
function allowedActions(
  status: SubmissionStatus,
  markings: ReadonlyArray<{ kind: string; status: string; assignmentId: string | null }>,
  assignments: ReadonlyArray<{ id: string; kind: string; endedAt: Date | null }>,
) {
  const current = new Set(assignments.filter((a) => a.endedAt === null).map((a) => a.id));
  const submitted = markings.filter((m) => (m.status === 'SUBMITTED' || m.status === 'APPROVED') && (m.kind === 'ADJUSTMENT' || (m.assignmentId && current.has(m.assignmentId))));
  const hasSecond = assignments.some((a) => a.kind === 'SECOND');
  const marked = status === 'MARKED';
  return {
    approve: marked,
    return: marked && submitted.some((m) => m.kind !== 'ADJUSTMENT'),
    requestSecondMarking: marked && !hasSecond,
    choose: marked,
    // Phase 4 (G6): a published result can be unlocked too — that withdraws it until approved and published again.
    unlock: status === 'APPROVED' || status === 'PUBLISHED',
    reassignFirst: ['ASSIGNED', 'MARKING_IN_PROGRESS', 'RETURNED'].includes(status),
    reassignSecond: ['AWAITING_SECOND_MARKING', 'MARKING_IN_PROGRESS', 'RETURNED'].includes(status) && hasSecond,
  };
}
