/**
 * Test Management (WS3, Phase 3): BLIND marking by coaches (tests.mark).
 *
 * Every request — the queue, a submission, a page, the paper, the marking guide, a draft, a submission for approval —
 * checks BOTH that the coach still holds an ACTIVE marker authorisation for the test's subject (403
 * MARKER_NOT_AUTHORIZED: revoked mid-way means refused at once) AND that the submission is currently assigned to them
 * (403 MARKING_NOT_ASSIGNED — also for a code that does not exist, so codes cannot be probed). Writes do both again
 * inside the transaction, under the submission's row lock.
 *
 * Blind, enforced here (not in the frontend): a marker's responses are built from an explicit whitelist — the opaque
 * submission code, the test (title, subject, maximum, questions), the answer of the current version (typed text, pages
 * under neutral names page-1.jpg …) and the coach's OWN marking. Never the student's name, username, school, contacts,
 * grade, the submitter or their role, a teacher, any time of submission (which would reveal a late answer under an
 * extension), extensions, or another marker and their marks (a second marker cannot see the first marks). Files are sent
 * with neutral names and no identifying header (Content-Disposition carries page-N.ext / test-paper.ext /
 * marking-guide.ext only), and an answer page's own identifying metadata (EXIF GPS / owner / serials, PDF author, XMP) is
 * removed before it is sent (answer-metadata.ts). Every response passes assertBlind (marking-rules.ts MARKER_FORBIDDEN_FIELDS) before it leaves.
 *
 * Marks: whole numbers (G7), per question when the test has questions (else one total), never above the maxima (the
 * database refuses too). Drafts are saved as often as needed (row lock: ten parallel saves apply one after another;
 * expectedRevision detects a stale screen); submitting sends the marking for approval. Every mark change is logged.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { isCoach, unsupportedRole } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { StorageService } from '../common/storage/storage.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { MarkingQueueQueryDto, SaveMarkingDto } from './dto/marking.dto.js';
import { assertBlind, normaliseMarks, queueState, type NormalisedMarks } from './marking-rules.js';
import { changeStatus, lockSubmission, writeMarks, type Actor, type LockedSubmission } from './marking-store.js';
import { stripIdentifyingMetadataForMarker } from './answer-metadata.js';
import { answerPageName } from './submission-rules.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { neutralFileName } from './test-rules.js';
import { markingSubjectsOf, mayMark } from './marker-reach.js';

type Tx = Prisma.TransactionClient;
type Db = Pick<Prisma.TransactionClient, 'testSubmission' | 'testMarkerAssignment' | 'markerAuthorization' | 'user'>;

const MARKING_TX = { maxWait: 15_000, timeout: 30_000 } as const;
/** XXXX-XXXX from the code alphabet (submission-rules.ts CODE_ALPHABET). */
const CODE_PATTERN = /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/;

const notAssigned = () => new AppError(HttpStatus.FORBIDDEN, 'MARKING_NOT_ASSIGNED', 'This answer is not assigned to you for marking. Open your marking list to see the answers assigned to you.');
const notAuthorised = () => new AppError(HttpStatus.FORBIDDEN, 'MARKER_NOT_AUTHORIZED', 'You are no longer allowed to mark this subject. If you think this is a mistake, ask your Head Coach.');

interface MarkerContext {
  submissionId: string;
  code: string;
  status: string;
  currentVersionId: string | null;
  test: { id: string; title: string; maxMarks: number; disciplineId: string; subject: { code: string; name: string } };
  assignment: { id: string; kind: 'FIRST' | 'SECOND' };
  marking: { id: string; status: 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'APPROVED'; revision: number; versionId: string } | null;
}

@Injectable()
export class TestMarkerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly deadlines: TestDeadlineService,
  ) {}

  // ── The queue ─────────────────────────────────────────────────────────────────

  /**
   * My current assignments in the subjects I am still authorised for: not started / in progress (a draft, or returned for
   * correction) / marked; by test, with my progress per test. Paginated; a fixed number of queries.
   */
  async queue(user: AuthUser, q: MarkingQueueQueryDto) {
    this.coach(user);
    const subjects = await markingSubjectsOf(this.prisma, user.id);
    const base: Prisma.TestMarkerAssignmentWhereInput = {
      coachId: user.id, endedAt: null,
      submission: { test: { disciplineId: { in: subjects } }, ...(q.testId && { testId: q.testId }) },
    };
    const stateWhere = (s: 'NOT_STARTED' | 'IN_PROGRESS' | 'MARKED' | 'TO_MARK'): Prisma.TestMarkerAssignmentWhereInput =>
      s === 'TO_MARK' ? { OR: [stateWhere('NOT_STARTED'), stateWhere('IN_PROGRESS')] }
      : s === 'NOT_STARTED' ? { marking: { is: null } }
        : s === 'IN_PROGRESS' ? { marking: { is: { status: { in: ['DRAFT', 'RETURNED'] } } } }
          : { marking: { is: { status: { in: ['SUBMITTED', 'APPROVED'] } } } };
    const where: Prisma.TestMarkerAssignmentWhereInput = { AND: [base, ...(q.state ? [stateWhere(q.state)] : [])] };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total, notStarted, inProgress, marked] = await this.prisma.$transaction([
      this.prisma.testMarkerAssignment.findMany({
        where, skip, take, orderBy: [{ assignedAt: 'asc' }, { id: 'asc' }],
        select: {
          assignedAt: true,
          submission: { select: { publicCode: true, test: { select: { id: true, title: true, maxMarks: true, discipline: { select: { code: true, name: true } } } } } },
          marking: { select: { status: true, totalMarks: true, revision: true, updatedAt: true } },
        },
      }),
      this.prisma.testMarkerAssignment.count({ where }),
      this.prisma.testMarkerAssignment.count({ where: { AND: [base, stateWhere('NOT_STARTED')] } }),
      this.prisma.testMarkerAssignment.count({ where: { AND: [base, stateWhere('IN_PROGRESS')] } }),
      this.prisma.testMarkerAssignment.count({ where: { AND: [base, stateWhere('MARKED')] } }),
    ]);
    const tests = subjects.length ? await this.prisma.$queryRaw<Array<{ id: string; title: string; assigned: number; notStarted: number; inProgress: number; marked: number }>>`
      SELECT t."id", t."title", count(*)::int AS "assigned",
             count(*) FILTER (WHERE m."id" IS NULL)::int AS "notStarted",
             count(*) FILTER (WHERE m."status" IN ('DRAFT', 'RETURNED'))::int AS "inProgress",
             count(*) FILTER (WHERE m."status" IN ('SUBMITTED', 'APPROVED'))::int AS "marked"
        FROM "TestMarkerAssignment" a
        JOIN "TestSubmission" s ON s."id" = a."submissionId"
        JOIN "Test" t ON t."id" = s."testId"
        LEFT JOIN "TestMarking" m ON m."assignmentId" = a."id"
       WHERE a."coachId" = ${user.id} AND a."endedAt" IS NULL AND t."disciplineId" = ANY(${subjects}::text[])
       GROUP BY t."id", t."title" ORDER BY t."title", t."id"` : [];
    const out = {
      ...paginated(rows.map((r) => ({
        code: r.submission.publicCode,
        test: { id: r.submission.test.id, title: r.submission.test.title, maxMarks: r.submission.test.maxMarks, subject: r.submission.test.discipline },
        state: queueState(r.marking?.status),
        returned: r.marking?.status === 'RETURNED',
        myTotal: r.marking?.totalMarks ?? null,
        assignedAt: r.assignedAt,
        savedAt: r.marking?.updatedAt ?? null,
      })), total, page, limit),
      counts: { notStarted, inProgress, marked, total: notStarted + inProgress + marked },
      tests,
    };
    assertBlind(out);
    return out;
  }

  /**
   * Coach dashboard (spec 12.2, Phase 4): MY current assignments only — not started, in progress, marked, returned for
   * correction, second markings, what needs my action — per test. Blind like the queue (assertBlind). Two queries.
   */
  async dashboard(user: AuthUser) {
    this.coach(user);
    const subjects = await markingSubjectsOf(this.prisma, user.id);
    const rows = subjects.length ? await this.prisma.$queryRaw<Array<{ id: string; title: string; subject: string; assigned: number; notStarted: number; inProgress: number; marked: number; returned: number; second: number }>>`
      SELECT t."id", t."title", d."name" AS "subject", count(*)::int AS "assigned",
             count(*) FILTER (WHERE m."id" IS NULL)::int AS "notStarted",
             count(*) FILTER (WHERE m."status" IN ('DRAFT', 'RETURNED'))::int AS "inProgress",
             count(*) FILTER (WHERE m."status" IN ('SUBMITTED', 'APPROVED'))::int AS "marked",
             count(*) FILTER (WHERE m."status" = 'RETURNED')::int AS "returned",
             count(*) FILTER (WHERE a."kind" = 'SECOND')::int AS "second"
        FROM "TestMarkerAssignment" a
        JOIN "TestSubmission" s ON s."id" = a."submissionId"
        JOIN "Test" t ON t."id" = s."testId"
        JOIN "Discipline" d ON d."id" = t."disciplineId"
        LEFT JOIN "TestMarking" m ON m."assignmentId" = a."id"
       WHERE a."coachId" = ${user.id} AND a."endedAt" IS NULL AND t."disciplineId" = ANY(${subjects}::text[])
       GROUP BY t."id", t."title", d."name" ORDER BY t."title", t."id"` : [];
    const sum = (k: 'assigned' | 'notStarted' | 'inProgress' | 'marked' | 'returned' | 'second') => rows.reduce((a, r) => a + r[k], 0);
    const out = {
      counts: {
        total: sum('assigned'), notStarted: sum('notStarted'), inProgress: sum('inProgress'), marked: sum('marked'),
        returned: sum('returned'), secondMarkings: sum('second'), needsAction: sum('notStarted') + sum('inProgress'),
      },
      tests: rows.map((r) => ({
        test: { id: r.id, title: r.title, subject: r.subject }, assigned: r.assigned, notStarted: r.notStarted, inProgress: r.inProgress,
        marked: r.marked, returned: r.returned, secondMarkings: r.second,
      })),
    };
    assertBlind(out);
    return out;
  }

  // ── One submission ─────────────────────────────────────────────────────────────

  /** What I need to mark it — and nothing that identifies the student (see the file header). */
  async get(user: AuthUser, code: string) {
    const ctx = await this.context(this.prisma, user, code);
    return this.view(ctx);
  }

  /** A page of the answer, under a neutral name (page-3.jpg); no identifying header. */
  async sendPage(user: AuthUser, code: string, pageNumber: number, res: Response, download: boolean) {
    const ctx = await this.context(this.prisma, user, code);
    const versionId = ctx.marking?.versionId ?? ctx.currentVersionId;
    const page = versionId ? await this.prisma.testAnswerPage.findFirst({
      where: { versionId, pageNumber }, select: { pageNumber: true, file: { select: { storageKey: true, mimeType: true, size: true } } },
    }) : null;
    if (!page) throw new AppError(HttpStatus.NOT_FOUND, 'PAGE_NOT_FOUND', 'Page not found.');
    // Blind: identifying metadata inside the file itself (EXIF GPS / owner / serials, PDF author, XMP) is removed.
    await this.storage.send(res, { ...page.file, originalName: answerPageName(page.pageNumber, page.file.mimeType) }, {
      download, transform: (data) => stripIdentifyingMetadataForMarker(data, page.file.mimeType),
    });
  }

  /** The test paper or the marking guide (the assigned marker may read the guide), under a neutral name. */
  async sendTestFile(user: AuthUser, code: string, kind: 'PAPER' | 'MARKING_GUIDE', res: Response, download: boolean) {
    const ctx = await this.context(this.prisma, user, code);
    const link = await this.prisma.testFile.findUnique({
      where: { testId_kind: { testId: ctx.test.id, kind } }, select: { file: { select: { storageKey: true, mimeType: true, size: true } } },
    });
    if (!link) throw new AppError(HttpStatus.NOT_FOUND, 'TEST_FILE_NOT_FOUND', 'This test has no such file.');
    await this.storage.send(res, { ...link.file, originalName: neutralFileName(kind, link.file.storageKey, ctx.test.title) }, { download });
  }

  // ── Drafts and submitting for approval ─────────────────────────────────────────

  /** Save my draft (the whole marking as given). The first save starts the marking (ASSIGNED / RETURNED → in progress). */
  async save(user: AuthUser, code: string, dto: SaveMarkingDto) {
    await this.write(user, code, dto, false);
    return this.get(user, code);
  }

  /**
   * Submit my marking for approval (every question marked, or the total). The same marks submitted again return the same
   * answer (replayed: true); different marks after submitting: 409 MARKING_SUBMITTED.
   */
  async submit(user: AuthUser, code: string, dto: SaveMarkingDto) {
    const replayed = await this.write(user, code, dto, true);
    return { ...(await this.get(user, code)), replayed };
  }

  private async write(user: AuthUser, code: string, dto: SaveMarkingDto, forSubmit: boolean): Promise<boolean> {
    this.coach(user);
    const actor: Actor = { id: user.id, actorRole: user.role };
    return this.prisma.$transaction(async (tx) => {
      const sub = await lockSubmission(tx, { publicCode: this.code(code) });
      if (!sub) throw notAssigned();
      const ctx = await this.context(tx, user, code, sub);
      const questions = await tx.testQuestion.findMany({ where: { testId: ctx.test.id }, select: { id: true, order: true, maxMarks: true } });
      const marks = normaliseMarks(questions, ctx.test.maxMarks, dto, forSubmit);

      if (ctx.marking && (ctx.marking.status === 'SUBMITTED' || ctx.marking.status === 'APPROVED')) {
        if (forSubmit && (await sameMarks(tx, ctx.marking.id, questions.length > 0, marks))) return true;
        throw new AppError(HttpStatus.CONFLICT, 'MARKING_SUBMITTED', 'This marking was submitted: it can no longer change unless a reviewer returns it.');
      }
      if (!['ASSIGNED', 'MARKING_IN_PROGRESS', 'RETURNED', 'AWAITING_SECOND_MARKING'].includes(sub.status)) {
        throw new AppError(HttpStatus.CONFLICT, 'INVALID_STATUS_TRANSITION', 'This submission cannot be marked now.', { status: sub.status });
      }
      if (sub.status === 'RETURNED' && ctx.marking?.status !== 'RETURNED') {
        throw new AppError(HttpStatus.CONFLICT, 'INVALID_STATUS_TRANSITION', 'Another marking was returned for correction, not yours.', { status: sub.status });
      }
      if (dto.expectedRevision !== undefined && dto.expectedRevision !== (ctx.marking?.revision ?? 0)) {
        throw new AppError(HttpStatus.CONFLICT, 'MARKING_CHANGED', 'Your marking was saved from somewhere else meanwhile; reload it.',
          { revision: ctx.marking?.revision ?? 0, expected: dto.expectedRevision });
      }
      if (!sub.currentVersionId) throw new AppError(HttpStatus.CONFLICT, 'INVALID_STATUS_TRANSITION', 'This submission has no answer.');
      const now = await this.deadlines.now(tx);
      const marking = ctx.marking ?? await tx.testMarking.create({
        data: {
          submissionId: sub.id, kind: ctx.assignment.kind, assignmentId: ctx.assignment.id, markerId: user.id,
          versionId: sub.currentVersionId, status: 'DRAFT', revision: 1, createdAt: now, updatedAt: now,
        },
        select: { id: true, status: true, revision: true, versionId: true },
      });
      const changed = await writeMarks(tx, marking.id, questions.length > 0, marks, actor, now, null);
      // The first save starts (or, after a return, restarts) the marking: one row of the transition table.
      if (sub.status === 'ASSIGNED' || sub.status === 'RETURNED') await changeStatus(tx, sub, 'START_MARKING', actor, now);
      if (forSubmit) {
        await tx.testMarking.update({ where: { id: marking.id }, data: { status: 'SUBMITTED', submittedAt: now } });
        await changeStatus(tx, sub, 'SUBMIT_MARKING', actor, now);
      }
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: forSubmit ? 'TEST_MARKING_SUBMITTED' : 'TEST_MARKING_DRAFT_SAVED',
        entity: 'TestMarking', entityId: marking.id,
        metadata: {
          testId: ctx.test.id, subjectId: ctx.test.disciplineId, submissionId: sub.id, kind: ctx.assignment.kind,
          totalMarks: marks.totalMarks, changes: changed, status: sub.status,
        },
      }, tx);
      return false;
    }, MARKING_TX);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private coach(user: AuthUser) {
    if (!isCoach(user)) throw unsupportedRole();
  }

  private code(code: string): string {
    const c = code.trim().toUpperCase();
    if (!CODE_PATTERN.test(c)) throw notAssigned();
    return c;
  }

  /**
   * The two checks of EVERY marker request: the submission is currently assigned to this coach (403
   * MARKING_NOT_ASSIGNED, also for an unknown code) and the coach is still authorised for its subject (403
   * MARKER_NOT_AUTHORIZED).
   */
  private async context(db: Db, user: AuthUser, rawCode: string, locked?: LockedSubmission): Promise<MarkerContext> {
    this.coach(user);
    const code = this.code(rawCode);
    const sub = await db.testSubmission.findUnique({
      where: { publicCode: code },
      select: {
        id: true, status: true, currentVersionId: true,
        test: { select: { id: true, title: true, maxMarks: true, disciplineId: true, discipline: { select: { code: true, name: true } } } },
      },
    });
    if (!sub) throw notAssigned();
    const assignment = await db.testMarkerAssignment.findFirst({
      where: { submissionId: sub.id, coachId: user.id, endedAt: null },
      select: { id: true, kind: true, marking: { select: { id: true, status: true, revision: true, versionId: true } } },
    });
    if (!assignment || assignment.kind === 'ADJUSTMENT') throw notAssigned();
    if (!(await mayMark(db, user.id, sub.test.disciplineId))) throw notAuthorised();
    return {
      submissionId: sub.id, code, status: locked?.status ?? sub.status, currentVersionId: locked?.currentVersionId ?? sub.currentVersionId,
      test: { id: sub.test.id, title: sub.test.title, maxMarks: sub.test.maxMarks, disciplineId: sub.test.disciplineId, subject: sub.test.discipline },
      assignment: { id: assignment.id, kind: assignment.kind },
      marking: assignment.marking,
    };
  }

  /** The marker's view (whitelist; assertBlind before it leaves). */
  private async view(ctx: MarkerContext) {
    const versionId = ctx.marking?.versionId ?? ctx.currentVersionId;
    const [questions, files, version, marking, returned] = await Promise.all([
      this.prisma.testQuestion.findMany({ where: { testId: ctx.test.id }, orderBy: { order: 'asc' }, select: { id: true, order: true, prompt: true, maxMarks: true } }),
      this.prisma.testFile.findMany({ where: { testId: ctx.test.id }, select: { kind: true, file: { select: { storageKey: true, mimeType: true, size: true } } } }),
      versionId ? this.prisma.testSubmissionVersion.findUnique({
        where: { id: versionId },
        select: { typedAnswer: true, pages: { orderBy: { pageNumber: 'asc' }, select: { pageNumber: true, file: { select: { mimeType: true, size: true } } } } },
      }) : null,
      ctx.marking ? this.prisma.testMarking.findUnique({
        where: { id: ctx.marking.id },
        select: { status: true, revision: true, totalMarks: true, comment: true, updatedAt: true, scores: { select: { questionId: true, marks: true, comment: true } } },
      }) : null,
      ctx.marking ? this.prisma.testReview.findFirst({
        where: { markingId: ctx.marking.id, action: { equals: 'RETURNED' } }, orderBy: { createdAt: 'desc' }, select: { comment: true, createdAt: true },
      }) : null,
    ]);
    const file = (kind: 'PAPER' | 'MARKING_GUIDE') => {
      const f = files.find((x) => x.kind === kind)?.file;
      return f ? { name: neutralFileName(kind, f.storageKey, ctx.test.title), mimeType: f.mimeType, size: f.size } : null;
    };
    const state = queueState(marking?.status);
    const editable = ['ASSIGNED', 'MARKING_IN_PROGRESS', 'RETURNED', 'AWAITING_SECOND_MARKING'].includes(ctx.status)
      && (!marking || marking.status === 'DRAFT' || marking.status === 'RETURNED')
      && (ctx.status !== 'RETURNED' || marking?.status === 'RETURNED');
    const out = {
      code: ctx.code,
      state,
      canEdit: editable,
      test: {
        id: ctx.test.id, title: ctx.test.title, maxMarks: ctx.test.maxMarks, subject: ctx.test.subject,
        questions, paper: file('PAPER'), markingGuide: file('MARKING_GUIDE'),
      },
      answer: {
        typedAnswer: version?.typedAnswer ?? null,
        pages: (version?.pages ?? []).map((p) => ({ page: p.pageNumber, name: answerPageName(p.pageNumber, p.file.mimeType), mimeType: p.file.mimeType, size: p.file.size })),
      },
      myMarking: marking && {
        status: marking.status, revision: marking.revision, totalMarks: marking.totalMarks, comment: marking.comment, savedAt: marking.updatedAt,
        scores: marking.scores,
        returnComment: marking.status === 'RETURNED' ? returned?.comment ?? null : null,
      },
    };
    assertBlind(out);
    return out;
  }
}

/** Whether a submitted marking already holds exactly these marks (a repeated submit). */
async function sameMarks(tx: Tx, markingId: string, hasQuestions: boolean, marks: NormalisedMarks): Promise<boolean> {
  const m = await tx.testMarking.findUniqueOrThrow({ where: { id: markingId }, select: { totalMarks: true, scores: { select: { questionId: true, marks: true } } } });
  if (m.totalMarks !== marks.totalMarks) return false;
  if (!hasQuestions) return true;
  const have = new Map(m.scores.map((s) => [s.questionId, s.marks]));
  return marks.scores.every((s) => have.get(s.questionId) === s.marks) && m.scores.length === marks.scores.length;
}
