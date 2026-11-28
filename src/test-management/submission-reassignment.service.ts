/**
 * Reassign a submission (owner 2026-11-28): Administrators and Super Administrators correct a test answer that was
 * submitted under the wrong subject or level, without the student submitting again.
 *
 * The subject and the level are properties of the TEST (Test.disciplineId, Test.division); the submission also keeps the
 * student's level when it was made (TestSubmission.level, its ranking group). A correction is therefore one of:
 *   - the level only, within the same test (a test for every level): any stage. The marks stay valid; the result's
 *     ranking group changes, which is the correction;
 *   - another test (another subject, or the test of the right level): the SAME submission row moves — its id, public
 *     code, versions, pages and files, typed answer, timestamps, status history and audit history are kept. Nothing is
 *     copied or deleted. Refused once marking has started (a marker assignment, a marking, question tasks, a review, a
 *     publication or a withdrawal): those records belong to the original test's questions and maximum and can be neither
 *     carried over nor silently dropped. Also refused when the student already has a submission for the destination test,
 *     when the destination does not accept this answer's format, or when the level is not the destination's.
 * Every correction is audited (TEST_SUBMISSION_REASSIGNED: who, when, before, after, reason).
 *
 * Answer pages keep the test they were uploaded under (TestAnswerPage.testId; committed pages are write-protected by the
 * database): every read of a submitted page goes through its version and the submission, never through that column.
 */
import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ListReassignableSubmissionsQueryDto, ReassignSubmissionDto } from './dto/submission.dto.js';
import { TestSubmissionsService } from './test-submissions.service.js';
import { TestsService } from './tests.service.js';

type Tx = Prisma.TransactionClient;

/** Why a destination test cannot take this submission (null: it can). */
export type DestinationProblem = 'SAME_TEST' | 'TEST_NOT_PUBLISHED' | 'DUPLICATE_SUBMISSION' | 'FORMAT_MISMATCH' | 'MARKING_STARTED';

const MARKING_STARTED_MESSAGE =
  'Marking of this answer has started under its current test. Moving it to another test would leave marks that belong to the '
  + 'current test\'s questions and maximum, so it is refused. You can still correct the level within the same test. To move it, '
  + 'first end the marking (return or reopen it so no marker holds it) — or keep it under this test and record the correction in a note.';

/** What already exists that belongs to the original test (any of these blocks a move to another test). */
export interface MarkingState { status: string; assignments: number; markings: number; questionTasks: number; reviews: number; withdrawals: number; published: boolean }

const markingStarted = (m: MarkingState) =>
  m.status !== 'SUBMITTED' || m.assignments > 0 || m.markings > 0 || m.questionTasks > 0 || m.reviews > 0 || m.withdrawals > 0 || m.published;

/** The answer's format needs: pages need uploads; a typed answer needs typing. */
function formatAccepts(format: string, answer: { pages: number; typed: boolean }): boolean {
  if (answer.pages > 0 && format === 'TYPED_ONLY') return false;
  if (answer.typed && format === 'UPLOAD_ONLY') return false;
  return true;
}

@Injectable()
export class SubmissionReassignmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tests: TestsService,
    private readonly submissions: TestSubmissionsService,
  ) {}

  /**
   * GET /admin/test-submissions: submitted answers across every test — ?q (student name, username, student id, the
   * paper's public code or the test title), ?subjectId, ?level (the submission's level), ?status, ?testId. Newest first.
   */
  async search(q: ListReassignableSubmissionsQueryDto) {
    const term = q.q?.trim();
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.TestSubmissionWhereInput = {
      versionCount: { gt: 0 },
      ...(q.testId && { testId: q.testId }),
      ...(q.subjectId && { test: { disciplineId: q.subjectId } }),
      ...(q.level && { level: q.level }),
      ...(q.status && { status: q.status }),
      ...(term && {
        OR: [
          { student: { firstName: { contains: term, mode: 'insensitive' } } },
          { student: { lastName: { contains: term, mode: 'insensitive' } } },
          { student: { username: { contains: term, mode: 'insensitive' } } },
          { publicCode: { equals: term.toUpperCase() } },
          { test: { title: { contains: term, mode: 'insensitive' } } },
          ...(/^[0-9a-f-]{36}$/i.test(term) ? [{ studentId: term }, { id: term }] : []),
        ],
      }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.testSubmission.findMany({
        where, skip, take, orderBy: [{ firstSubmittedAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true, publicCode: true, status: true, level: true, firstSubmittedAt: true, lastSubmittedAt: true,
          student: { select: { id: true, username: true, firstName: true, lastName: true } },
          test: { select: { id: true, title: true, division: true, discipline: { select: { id: true, code: true, name: true } } } },
        },
      }),
      this.prisma.testSubmission.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /**
   * GET /admin/tests/:id/submissions/:submissionId/reassignment: the current test, subject and level; the levels; every
   * published test as a destination, each with whether it can take this answer and why not; whether marking has started.
   */
  async options(testId: string, submissionId: string, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const sub = await this.load(this.prisma, testId, submissionId);
    const marking = await this.markingState(this.prisma, sub);
    const started = markingStarted(marking);
    const [divisions, tests, taken] = await Promise.all([
      this.prisma.division.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { code: true, name: true } }),
      this.prisma.test.findMany({
        // Every published test, and always the current one (a level-only correction needs it).
        where: { OR: [{ status: 'PUBLISHED' }, { id: sub.testId }] }, orderBy: [{ discipline: { name: 'asc' } }, { title: 'asc' }],
        select: { id: true, title: true, division: true, answerFormat: true, status: true, closesAt: true, discipline: { select: { id: true, code: true, name: true } } },
      }),
      this.prisma.testSubmission.findMany({ where: { studentId: sub.studentId }, select: { testId: true } }),
    ]);
    const takenIds = new Set(taken.map((t) => t.testId));
    const answer = { pages: sub.currentVersion?.pageCount ?? 0, typed: !!sub.currentVersion?.typedAnswer };
    const destinations = tests.map((t) => {
      const problem: DestinationProblem | null =
        t.id === sub.testId ? 'SAME_TEST'
          : started ? 'MARKING_STARTED'
            : takenIds.has(t.id) ? 'DUPLICATE_SUBMISSION'
              : !formatAccepts(t.answerFormat, answer) ? 'FORMAT_MISMATCH'
                : null;
      return { id: t.id, title: t.title, division: t.division, answerFormat: t.answerFormat, closesAt: t.closesAt, subject: t.discipline, available: problem === null || problem === 'SAME_TEST', problem };
    });
    return {
      submission: {
        id: sub.id, publicCode: sub.publicCode, status: sub.status, level: sub.level,
        firstSubmittedAt: sub.firstSubmittedAt, lastSubmittedAt: sub.lastSubmittedAt,
        student: sub.student, answer,
      },
      current: { test: { id: sub.test.id, title: sub.test.title, division: sub.test.division }, subject: sub.test.discipline, level: sub.level },
      markingStarted: started,
      marking,
      ...(started && { markingStartedMessage: MARKING_STARTED_MESSAGE }),
      levels: divisions,
      destinations,
    };
  }

  /**
   * POST /admin/tests/:id/submissions/:submissionId/reassignment { testId, level, reason, expectedTestId? }.
   * 400 NO_CHANGE, LEVEL_NOT_FOUND, LEVEL_NOT_IN_TEST, FORMAT_MISMATCH; 404 TEST_NOT_FOUND, SUBMISSION_NOT_FOUND;
   * 409 NOTHING_SUBMITTED, TEST_NOT_PUBLISHED, DUPLICATE_SUBMISSION, MARKING_STARTED, SUBMISSION_CHANGED.
   */
  async reassign(testId: string, submissionId: string, dto: ReassignSubmissionDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const result = await this.prisma.$transaction(async (tx) => {
      // The row is locked: a concurrent submit, replacement, marking assignment or second correction waits.
      const [locked] = await tx.$queryRaw<Array<{ id: string; testId: string }>>`
        SELECT "id", "testId" FROM "TestSubmission" WHERE "id" = ${submissionId} FOR UPDATE`;
      if (!locked) throw submissionNotFound();
      if (locked.testId !== testId || (dto.expectedTestId && dto.expectedTestId !== locked.testId)) {
        throw new AppError(HttpStatus.CONFLICT, 'SUBMISSION_CHANGED', 'This answer was moved by someone else meanwhile. Reload the page and check it again.', { testId: locked.testId });
      }
      const sub = await this.load(tx, testId, submissionId);
      if (sub.versionCount === 0) throw new AppError(HttpStatus.CONFLICT, 'NOTHING_SUBMITTED', 'Nothing has been submitted yet: there is nothing to correct.');

      const level = await tx.division.findUnique({ where: { code: dto.level }, select: { code: true } });
      if (!level) throw new AppError(HttpStatus.BAD_REQUEST, 'LEVEL_NOT_FOUND', 'That level does not exist. Choose one of the levels listed.', { level: dto.level });

      const moving = dto.testId !== sub.testId;
      const dest = moving
        ? await tx.test.findUnique({ where: { id: dto.testId }, select: { id: true, title: true, status: true, division: true, answerFormat: true, discipline: { select: { id: true, code: true, name: true } } } })
        : { id: sub.test.id, title: sub.test.title, status: 'PUBLISHED', division: sub.test.division, answerFormat: sub.test.answerFormat, discipline: sub.test.discipline };
      if (!dest) throw new AppError(HttpStatus.NOT_FOUND, 'TEST_NOT_FOUND', 'The destination test was not found. Choose one of the tests listed.', { testId: dto.testId });
      if (!moving && dto.level === sub.level) throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGE', 'Nothing changes: choose another test or another level.');
      if (dest.division !== 'ALL' && dest.division !== dto.level) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'LEVEL_NOT_IN_TEST', `The test "${dest.title}" is for the ${dest.division} level only. Choose that level, or a test for this level.`, { testDivision: dest.division, level: dto.level });
      }
      const marking = await this.markingState(tx, sub);
      if (moving) {
        if (dest.status !== 'PUBLISHED') throw new AppError(HttpStatus.CONFLICT, 'TEST_NOT_PUBLISHED', 'The destination test is not published. Choose a published test.', { testId: dest.id });
        if (markingStarted(marking)) throw new AppError(HttpStatus.CONFLICT, 'MARKING_STARTED', MARKING_STARTED_MESSAGE, { ...marking });
        const answer = { pages: sub.currentVersion?.pageCount ?? 0, typed: !!sub.currentVersion?.typedAnswer };
        if (!formatAccepts(dest.answerFormat, answer)) {
          throw new AppError(HttpStatus.BAD_REQUEST, 'FORMAT_MISMATCH', `The test "${dest.title}" does not accept this kind of answer (${answer.pages > 0 ? 'uploaded pages' : 'a typed answer'}). Choose another test.`, { answerFormat: dest.answerFormat });
        }
        const existing = await tx.testSubmission.findUnique({ where: { testId_studentId: { testId: dest.id, studentId: sub.studentId } }, select: { id: true, publicCode: true } });
        if (existing) {
          throw new AppError(HttpStatus.CONFLICT, 'DUPLICATE_SUBMISSION', `This student already has an answer for "${dest.title}" (${existing.publicCode}). Two answers for one test are not allowed: correct or remove the other one first.`, { submissionId: existing.id, publicCode: existing.publicCode });
        }
      }

      await tx.testSubmission.update({ where: { id: sub.id }, data: { testId: dest.id, level: dto.level } });
      const before = { testId: sub.test.id, testTitle: sub.test.title, subjectCode: sub.test.discipline.code, subjectName: sub.test.discipline.name, testDivision: sub.test.division, level: sub.level };
      const after = { testId: dest.id, testTitle: dest.title, subjectCode: dest.discipline.code, subjectName: dest.discipline.name, testDivision: dest.division, level: dto.level };
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_SUBMISSION_REASSIGNED', entity: 'TestSubmission', entityId: sub.id,
        metadata: { studentId: sub.studentId, publicCode: sub.publicCode, status: sub.status, before, after, reason: dto.reason, movedTest: moving, markingStarted: markingStarted(marking) },
      }, tx);
      return { before, after, moved: moving };
    });
    return { ...result, submission: await this.submissions.staffDetail(result.after.testId, submissionId, user) };
  }

  /** GET …/reassignment/history: the corrections of this submission, newest first (from the audit log). */
  async history(testId: string, submissionId: string, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    await this.load(this.prisma, testId, submissionId);
    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'TestSubmission', entityId: submissionId, action: 'TEST_SUBMISSION_REASSIGNED' }, orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, actorRole: true, metadata: true, actor: { select: { id: true, username: true, firstName: true, lastName: true } } },
    });
    return rows.map((r) => {
      const m = (r.metadata ?? {}) as { before?: unknown; after?: unknown; reason?: string };
      return { id: r.id, at: r.createdAt, actorRole: r.actorRole, actor: r.actor, before: m.before ?? null, after: m.after ?? null, reason: m.reason ?? null };
    });
  }

  private async load(db: Tx | PrismaService, testId: string, submissionId: string) {
    const sub = await db.testSubmission.findFirst({
      where: { id: submissionId, testId },
      select: {
        id: true, testId: true, studentId: true, publicCode: true, status: true, level: true, versionCount: true, publicationId: true,
        firstSubmittedAt: true, lastSubmittedAt: true,
        student: { select: { id: true, username: true, firstName: true, lastName: true } },
        currentVersion: { select: { pageCount: true, typedAnswer: true } },
        test: { select: { id: true, title: true, division: true, answerFormat: true, discipline: { select: { id: true, code: true, name: true } } } },
      },
    });
    if (!sub) throw submissionNotFound();
    return sub;
  }

  private async markingState(db: Tx | PrismaService, sub: { id: string; status: string; publicationId: string | null }): Promise<MarkingState> {
    // Sequential: inside a transaction every query shares one connection.
    const assignments = await db.testMarkerAssignment.count({ where: { submissionId: sub.id } });
    const markings = await db.testMarking.count({ where: { submissionId: sub.id } });
    const questionTasks = await db.testQuestionTask.count({ where: { submissionId: sub.id } });
    const reviews = await db.testReview.count({ where: { submissionId: sub.id } });
    const withdrawals = await db.testResultWithdrawal.count({ where: { submissionId: sub.id } });
    return { status: sub.status, assignments, markings, questionTasks, reviews, withdrawals, published: sub.publicationId !== null };
  }
}

const submissionNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
