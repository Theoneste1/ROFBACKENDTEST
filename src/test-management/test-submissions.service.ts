/**
 * Test Management (WS3, Phase 2): submissions — by the student, or for the student by a teacher of their school (G2) —
 * every version kept; and their tracking for Administrators and the subject's Head Coaches.
 *
 * Who
 *   Student (tests.submit, own)           their own submission to a PUBLISHED test of their division, once it opened.
 *   Teacher (tests.submitForStudents,     any teacher of the school, primary or secondary: only students (current PENDING or VERIFIED claim) of
 *            school; G2)                  their own ACTIVE schools whose account is ACTIVE (teacher-scope.ts
 *                                         visibleSchoolStudentsWhere). Another student: 403 STUDENT_NOT_IN_SCOPE. The
 *                                         course-assignment delegation submissions.submitOnBehalf is separate and unchanged.
 *   Administrator / Head Coach            tracking and every version with the submitter and extension status
 *            (tests.viewSubmissions)      (Head Coaches: the subjects they head, TestsService.loadInScope).
 *
 * How a version is committed (one transaction, idempotent, race-free):
 *   1. the test row FOR SHARE (test writes, extensions, unpublish wait; so does this for them);
 *   2. the student's submission row created if missing (opaque public code) and locked FOR UPDATE — parallel submissions
 *      for one student run one after the other, so versions are numbered 1, 2, 3 … without gaps or duplicates;
 *   3. a version with this clientKey already exists → it is returned (a retried request never makes a second one);
 *   4. database time; eligibility (published, opened, division, active account); the applicable deadline
 *      (TestDeadlineService, incl. extensions) — after it: 409 DEADLINE_PASSED;
 *   5. the pending pages uploaded under clientKey (1…n, all present) and the typed answer, against the answer format;
 *   6. the version (submitter, role, teacher, time, deadline, under-extension flag), its pages, the submission's current
 *      version, the status history (first time: SUBMITTED), the audit entry (TESTS).
 * Pages are uploaded one at a time (a weak connection retries ONE page): each belongs to its pending upload until a
 * version commits it, then never changes (database trigger).
 *
 * Locked after submission (owner, 2026-11-21): the first version locks the answer — neither the student nor any teacher
 * can replace it (409 SUBMISSION_LOCKED, checked under the submission's row lock, so a student and a teacher submitting
 * at the same moment cannot both succeed). Only an Administrator (tests.authorizeResubmission) unlocks it for ONE
 * replacement, with a reason; the replacement uses the authorization and is locked again. Every version is kept.
 *
 * Visibility: students and teachers see the deadline that applies to them (extension included) but never an "extended"
 * flag, the extension or the under-extension mark; Administrators and Head Coaches see all of it. Lists are paginated and
 * read in a fixed number of queries.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import { AccessService } from '../common/access/access.service.js';
import { isStudent, isTeacher, unsupportedRole } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { StorageService } from '../common/storage/storage.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { visibleSchoolStudentsWhere } from '../teachers/teacher-scope.js';
import type {
  AuthorizeResubmissionDto, ListMyTestsQueryDto, ListTeacherTestStudentsQueryDto, ListTestSubmissionsQueryDto, SubmitTestAnswerDto,
} from './dto/submission.dto.js';
import {
  MAX_ANSWER_PAGES, answerPageName, answerWindow, applicableDeadline, assertAnswerFormat, assertBeforeDeadline, assertEligible,
  assertPagesComplete, assertUploadsAllowed, divisionMatches, eligibilityProblems, formatPublicCode, levelOf, levelWhere,
  trackingState, type ApplicableDeadline, type Submitter,
} from './submission-rules.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { neutralFileName } from './test-rules.js';
import { TestsService, testNotFound } from './tests.service.js';

type Tx = Prisma.TransactionClient;

/** The caller acting on a student's answer: the student themself, or a teacher with their schools. */
export type Answerer = { user: AuthUser; role: 'STUDENT' } | { user: AuthUser; role: 'TEACHER'; schools: string[] };

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;
const STUDENT_FIELDS = {
  id: true, username: true, firstName: true, lastName: true, role: true, accountStatus: true, isActive: true, isApproved: true,
  activatedAt: true, gradeLevel: true, schoolId: true, division: { select: { code: true } }, school: { select: { id: true, name: true } },
} as const satisfies Prisma.UserSelect;
type StudentRow = Prisma.UserGetPayload<{ select: typeof STUDENT_FIELDS }>;

const TEST_FOR_ANSWERERS = {
  discipline: { select: { id: true, code: true, name: true } },
  files:      { where: { kind: 'PAPER' as const }, select: { file: { select: { storageKey: true, mimeType: true, size: true } } } },
  questions:  { orderBy: { order: 'asc' as const }, select: { order: true, prompt: true, maxMarks: true } },
} as const satisfies Prisma.TestInclude;
type AnswererTest = Prisma.TestGetPayload<{ include: typeof TEST_FOR_ANSWERERS }>;

const PAGE_SELECT = { pageNumber: true, file: { select: { mimeType: true, size: true } } } as const;
const VERSION_SELECT = {
  id: true, number: true, submittedAt: true, submitterRole: true, applicableDeadline: true, underExtension: true, extensionId: true,
  typedAnswer: true, pageCount: true,
  submittedBy: { select: { id: true, username: true, firstName: true, lastName: true, role: true } },
  teacher: PERSON,
  pages: { orderBy: { pageNumber: 'asc' as const }, select: PAGE_SELECT },
} as const satisfies Prisma.TestSubmissionVersionSelect;
type VersionRow = Prisma.TestSubmissionVersionGetPayload<{ select: typeof VERSION_SELECT }>;

const SUMMARY_SELECT = {
  id: true, testId: true, studentId: true, publicCode: true, status: true, versionCount: true, firstSubmittedAt: true, lastSubmittedAt: true,
  resubmissionAuthorizations: { where: { usedAt: null, cancelledAt: null }, select: { id: true } },
  currentVersion: {
    select: { number: true, submittedAt: true, submitterRole: true, underExtension: true, submittedBy: PERSON, teacher: PERSON },
  },
} as const satisfies Prisma.TestSubmissionSelect;
type SummaryRow = Prisma.TestSubmissionGetPayload<{ select: typeof SUMMARY_SELECT }>;

/** Commit transactions wait for each other on the student's row lock: room for many parallel attempts. */
const SUBMIT_TX = { maxWait: 15_000, timeout: 30_000 } as const;

const notInScope = () => new AppError(HttpStatus.FORBIDDEN, 'STUDENT_NOT_IN_SCOPE',
  'You can submit only for students of your own schools.');
const pageNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'PAGE_NOT_FOUND', 'That page of the answer was not found. Reload the page to see the current answer.');
const submissionNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'SUBMISSION_NOT_FOUND', 'No answer was found for this test. Reload the page; if you have not sent an answer yet, send it first.');

@Injectable()
export class TestSubmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly deadlines: TestDeadlineService,
    private readonly tests: TestsService,
  ) {}

  // ── Who is acting ───────────────────────────────────────────────────────────

  /** A Student acting on their own answer (any other role: 403 ROLE_NOT_SUPPORTED). */
  studentCaller(user: AuthUser): Answerer {
    if (!isStudent(user)) throw unsupportedRole();
    return { user, role: 'STUDENT' };
  }

  /** A Teacher with their ACTIVE schools, read fresh (any other role: 403 ROLE_NOT_SUPPORTED). */
  async teacherCaller(user: AuthUser): Promise<Answerer> {
    if (!isTeacher(user)) throw unsupportedRole();
    return { user, role: 'TEACHER', schools: await this.access.teacherSchools(user) };
  }

  /** The student this caller acts for: themself, or (teacher) a student of their schools — else 403. */
  private async studentFor(caller: Answerer, studentId: string): Promise<StudentRow> {
    if (caller.role === 'STUDENT') {
      const me = await this.prisma.user.findUnique({ where: { id: caller.user.id }, select: STUDENT_FIELDS });
      if (!me) throw unsupportedRole();
      return me;
    }
    const s = await this.prisma.user.findFirst({ where: { AND: [{ id: studentId }, visibleSchoolStudentsWhere(caller.schools)] }, select: STUDENT_FIELDS });
    if (!s) throw notInScope();
    return s;
  }

  private submitterOf(caller: Answerer): Submitter {
    return caller.role === 'STUDENT' ? { role: 'STUDENT' } : { role: 'TEACHER', teacherId: caller.user.id };
  }

  /** A PUBLISHED test (a draft is not revealed: 404 TEST_NOT_FOUND); a student sees only their division's tests. */
  private async answererTest(testId: string, student?: StudentRow): Promise<AnswererTest> {
    const t = await this.prisma.test.findUnique({ where: { id: testId }, include: TEST_FOR_ANSWERERS });
    if (!t || t.status !== 'PUBLISHED') throw testNotFound();
    if (student && !divisionMatches(t.division, student)) throw testNotFound();
    return t;
  }

  // ── Student: my tests ─────────────────────────────────────────────────────────

  /** Published tests of my division with the deadline that applies to ME (extension included) and my submission. */
  async listMine(user: AuthUser, q: ListMyTestsQueryDto) {
    this.studentCaller(user);
    const me = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: STUDENT_FIELDS });
    // The student's Olympiad level (owner 2026-11-21), not their grade.
    const division = levelOf(me);
    const now = await this.deadlines.now();
    const mine: Prisma.TestExtensionWhereInput = { cancelledAt: null, OR: [{ kind: 'TEST' }, { kind: 'STUDENT', studentId: me.id }] };
    const where: Prisma.TestWhereInput = {
      status: 'PUBLISHED',
      division: { in: division ? ['ALL', division] : ['ALL'] },
      ...windowWhere(q.window, now, mine),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.test.findMany({
        where, skip, take, orderBy: [{ opensAt: 'desc' }, { id: 'asc' }],
        select: { id: true, title: true, division: true, answerFormat: true, opensAt: true, closesAt: true, maxMarks: true, discipline: { select: { id: true, code: true, name: true } } },
      }),
      this.prisma.test.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const [extensions, subs] = ids.length ? await Promise.all([
      this.prisma.testExtension.findMany({ where: { testId: { in: ids }, ...mine }, select: { id: true, testId: true, kind: true, studentId: true, teacherId: true, newDeadline: true, cancelledAt: true } }),
      this.prisma.testSubmission.findMany({
        where: { testId: { in: ids }, studentId: me.id },
        select: { testId: true, status: true, versionCount: true, lastSubmittedAt: true, resubmissionAuthorizations: { where: OPEN_AUTHORIZATION, select: { id: true } } },
      }),
    ]) : [[], []];
    const subOf = new Map(subs.map((s) => [s.testId, s]));
    const accountOk = eligibilityProblems({ status: 'PUBLISHED', opensAt: now, division: 'ALL' }, me, now).length === 0;
    return paginated(rows.map((t) => {
      const d = applicableDeadline(t.closesAt, extensions.filter((e) => e.testId === t.id), me.id, { role: 'STUDENT' });
      const window = answerWindow(t.opensAt, d.deadline, now);
      const sub = subOf.get(t.id) ?? null;
      return {
        id: t.id, title: t.title, subject: t.discipline, division: t.division, answerFormat: t.answerFormat, maxMarks: t.maxMarks,
        opensAt: t.opensAt, deadline: d.deadline, window,
        submission: sub && {
          status: sub.status, versionCount: sub.versionCount, lastSubmittedAt: sub.lastSubmittedAt,
          // Locked after submission unless an Administrator's authorization is open (owner 2026-11-21).
          locked: sub.status !== 'SUBMITTED' || (sub.versionCount > 0 && sub.resubmissionAuthorizations.length === 0),
          resubmissionOpen: sub.resubmissionAuthorizations.length > 0,
        },
        canSubmit: accountOk && window === 'OPEN' && (!sub || (sub.status === 'SUBMITTED' && (sub.versionCount === 0 || sub.resubmissionAuthorizations.length > 0))),
      };
    }), total, page, limit);
  }

  /** One test as the student sees it: details (questions once it opened), MY deadline, my submission and its versions. */
  async getMine(user: AuthUser, testId: string) {
    const caller = this.studentCaller(user);
    const me = await this.studentFor(caller, user.id);
    return this.answererView(caller, testId, me);
  }

  // ── Teacher: tests for my students ────────────────────────────────────────────

  /** Published tests, with how many of my (verified, active) students may answer each and how many have submitted. */
  async listForTeacher(user: AuthUser, q: ListMyTestsQueryDto) {
    const caller = await this.teacherCaller(user);
    const schools = caller.role === 'TEACHER' ? caller.schools : [];
    const now = await this.deadlines.now();
    const mine: Prisma.TestExtensionWhereInput = { cancelledAt: null, OR: [{ kind: 'TEST' }, { kind: 'TEACHER', teacherId: user.id }] };
    const where: Prisma.TestWhereInput = { status: 'PUBLISHED', ...windowWhere(q.window, now, mine) };
    const { page, limit, skip, take } = pageArgs(q);
    const students = visibleSchoolStudentsWhere(schools);
    const [rows, total, all, byDivision] = await this.prisma.$transaction([
      this.prisma.test.findMany({
        where, skip, take, orderBy: [{ opensAt: 'desc' }, { id: 'asc' }],
        select: { id: true, title: true, division: true, answerFormat: true, opensAt: true, closesAt: true, maxMarks: true, discipline: { select: { id: true, code: true, name: true } } },
      }),
      this.prisma.test.count({ where }),
      this.prisma.user.count({ where: students }),
      // Students per division (whatever divisions exist): the count for each test's level.
      this.prisma.user.groupBy({ by: ['divisionId'], where: students, _count: { _all: true }, orderBy: { divisionId: 'asc' } }),
    ]);
    const codeOf = new Map((await this.prisma.division.findMany({ select: { id: true, code: true } })).map((d) => [d.id, d.code]));
    const perCode = new Map(byDivision.map((g) => [codeOf.get(g.divisionId ?? '') ?? '', g._count._all]));
    const ids = rows.map((r) => r.id);
    const [extensions, submitted] = ids.length ? await Promise.all([
      this.prisma.testExtension.findMany({ where: { testId: { in: ids }, ...mine }, select: { id: true, testId: true, kind: true, studentId: true, teacherId: true, newDeadline: true, cancelledAt: true } }),
      this.prisma.testSubmission.groupBy({ by: ['testId'], where: { testId: { in: ids }, student: students }, _count: { _all: true } }),
    ]) : [[], []];
    const submittedOf = new Map(submitted.map((s) => [s.testId, s._count._all]));
    return paginated(rows.map((t) => {
      // The general deadline for this teacher (test + their own extension); a student's own extension may be later.
      const d = applicableDeadline(t.closesAt, extensions.filter((e) => e.testId === t.id), '', { role: 'TEACHER', teacherId: user.id });
      return {
        id: t.id, title: t.title, subject: t.discipline, division: t.division, answerFormat: t.answerFormat, maxMarks: t.maxMarks,
        opensAt: t.opensAt, deadline: d.deadline, window: answerWindow(t.opensAt, d.deadline, now),
        students: t.division === 'ALL' ? all : (perCode.get(t.division) ?? 0),
        submitted: submittedOf.get(t.id) ?? 0,
      };
    }), total, page, limit);
  }

  /** My students who may answer this test: each one's deadline (when I submit), state and submission; with counts. */
  async teacherTestStudents(user: AuthUser, testId: string, q: ListTeacherTestStudentsQueryDto) {
    const caller = await this.teacherCaller(user);
    const schools = caller.role === 'TEACHER' ? caller.schools : [];
    if (q.schoolId && !schools.includes(q.schoolId)) throw new AppError(HttpStatus.NOT_FOUND, 'SCHOOL_NOT_FOUND', 'School not found.');
    const test = await this.answererTest(testId);
    const now = await this.deadlines.now();
    const submitter: Submitter = { role: 'TEACHER', teacherId: user.id };
    const general = applicableDeadline(test.closesAt, await this.deadlines.activeExtensions(this.prisma, testId, { teacherId: user.id }), '', submitter);
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const population: Prisma.UserWhereInput = {
      AND: [
        visibleSchoolStudentsWhere(q.schoolId ? [q.schoolId] : schools),
        ...(test.division !== 'ALL' ? [levelWhere(test.division)] : []),
        ...(contains ? [{ OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }] : []),
      ],
    };
    // Level and subject (owner 2026-11-21): narrow the list; the counts stay those of every eligible student.
    const narrowed: Prisma.UserWhereInput[] = [
      ...(q.division ? [levelWhere(q.division)] : []),
      ...(q.subject ? [{ olympiadInterests: { has: q.subject } }] : []),
    ];
    const where: Prisma.UserWhereInput = { AND: [population, ...narrowed, ...(q.status ? [stateWhere(q.status, testId, general.deadline, now)] : [])] };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total, ...counts] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: {
          id: true, username: true, firstName: true, lastName: true, gradeLevel: true, olympiadInterests: true, olympiadInterestOther: true,
          division: { select: { code: true, name: true } },
          school: { select: { id: true, name: true } },
        },
      }),
      this.prisma.user.count({ where }),
      ...(['SUBMITTED', 'NOT_SUBMITTED', 'LATE_BLOCKED'] as const).map((s) =>
        this.prisma.user.count({ where: { AND: [population, stateWhere(s, testId, general.deadline, now)] } })),
    ]);
    const ids = rows.map((r) => r.id);
    const [subs, deadlines] = await Promise.all([
      ids.length ? this.prisma.testSubmission.findMany({ where: { testId, studentId: { in: ids } }, select: SUMMARY_SELECT }) : [],
      this.deadlines.forStudents(this.prisma, test, ids, submitter),
    ]);
    const subOf = new Map(subs.map((s) => [s.studentId, s]));
    const out = paginated(rows.map((s) => {
      const d = deadlines.get(s.id)!;
      const sub = subOf.get(s.id) ?? null;
      const state = trackingState(sub !== null, now, d.deadline);
      // Locked after submission unless an Administrator's authorization is open (owner 2026-11-21).
      const locked = sub !== null && (sub.status !== 'SUBMITTED' || (sub.versionCount > 0 && sub.resubmissionAuthorizations.length === 0));
      return {
        // division: the Olympiad level (kept under its former name for older screens).
        // division: the student's division code (their Olympiad level); divisionName for display.
        student: { ...s, division: s.division?.code ?? null, divisionName: s.division?.name ?? null }, deadline: d.deadline, state,
        submission: sub && answererSummary(sub),
        canSubmit: test.opensAt.getTime() <= now.getTime() && state !== 'LATE_BLOCKED' && !locked,
      };
    }), total, page, limit);
    return { ...out, counts: { students: counts[0] + counts[1] + counts[2], submitted: counts[0], notSubmitted: counts[1], lateBlocked: counts[2] } };
  }

  /** One of my students for this test: the details, the deadline when I submit for them, the submission's versions. */
  async teacherTestStudent(user: AuthUser, testId: string, studentId: string) {
    const caller = await this.teacherCaller(user);
    const student = await this.studentFor(caller, studentId);
    return this.answererView(caller, testId, student);
  }

  // ── Answer pages (one at a time) and committing a version ─────────────────────

  /**
   * Upload ONE page under the client's uploadKey (re-uploading the same page number replaces it while it is pending).
   * Everything is checked BEFORE the file is stored: scope, eligibility, the deadline, the answer format.
   */
  async uploadPage(caller: Answerer, testId: string, studentId: string, uploadKey: string, pageNumber: number, file: Express.Multer.File | undefined) {
    const student = await this.studentFor(caller, studentId);
    const test = await this.answererTest(testId, caller.role === 'STUDENT' ? student : undefined);
    if (pageNumber < 1 || pageNumber > MAX_ANSWER_PAGES) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_PAGES', `An answer can have at most ${MAX_ANSWER_PAGES} pages. Remove a page before adding another.`, { max: MAX_ANSWER_PAGES });
    }
    const now = await this.deadlines.now();
    assertEligible(test, student, now);
    assertUploadsAllowed(test.answerFormat);
    assertBeforeDeadline(now, await this.deadlines.forSubmission(this.prisma, test, student.id, this.submitterOf(caller)));
    await this.assertAnswerOpen(testId, student.id);
    if (!file) throw new AppError(HttpStatus.BAD_REQUEST, 'FILE_REQUIRED', 'Attach the page (multipart field "file").');
    const stored = await this.storage.store(file, 'TEST_ANSWER', caller.user.id);

    await this.prisma.$transaction(async (tx) => {
      await this.assertKeyNotCommitted(tx, testId, student.id, uploadKey);
      const [row] = await tx.$queryRaw<Array<{ id: string; inserted: boolean }>>`
        INSERT INTO "TestAnswerPage" ("id", "testId", "studentId", "uploadKey", "pageNumber", "fileId", "uploadedById", "uploaderRole", "createdAt", "updatedAt")
        VALUES (${randomUUID()}, ${testId}, ${student.id}, ${uploadKey}, ${pageNumber}, ${stored.id}, ${caller.user.id},
                ${caller.role}::"TestSubmitterRole", (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))
        ON CONFLICT ("testId", "studentId", "uploadKey", "pageNumber") DO UPDATE
          SET "fileId" = EXCLUDED."fileId", "updatedAt" = EXCLUDED."updatedAt"
          WHERE "TestAnswerPage"."versionId" IS NULL AND "TestAnswerPage"."uploadedById" = EXCLUDED."uploadedById"
        RETURNING "id", (xmax = 0) AS inserted`;
      if (!row) throw keyInUse();
      await this.audit.log({
        actorId: caller.user.id, actorRole: caller.user.role, action: 'TEST_ANSWER_PAGE_UPLOADED', entity: 'TestAnswerPage', entityId: row.id,
        metadata: {
          testId, subjectId: test.disciplineId, studentId: student.id, uploadKey, page: pageNumber, replaced: !row.inserted,
          fileId: stored.id, mimeType: stored.mimeType, size: stored.size, submitterRole: caller.role,
        },
      }, tx);
    });
    return this.pendingPages(caller, testId, student.id, uploadKey);
  }

  /** The pages uploaded so far under uploadKey and not yet submitted (to resume after a lost connection). */
  async pendingPages(caller: Answerer, testId: string, studentId: string, uploadKey: string) {
    const student = await this.studentFor(caller, studentId);
    await this.answererTest(testId, caller.role === 'STUDENT' ? student : undefined);
    const pages = await this.prisma.testAnswerPage.findMany({
      where: { testId, studentId: student.id, uploadKey, versionId: null, uploadedById: caller.user.id },
      orderBy: { pageNumber: 'asc' }, select: { pageNumber: true, updatedAt: true, file: { select: { mimeType: true, size: true } } },
    });
    return {
      uploadKey,
      pages: pages.map((p) => ({ page: p.pageNumber, name: answerPageName(p.pageNumber, p.file.mimeType), mimeType: p.file.mimeType, size: p.file.size, uploadedAt: p.updatedAt })),
    };
  }

  /** Remove a pending page (never a submitted one). */
  async removePendingPage(caller: Answerer, testId: string, studentId: string, uploadKey: string, pageNumber: number) {
    const student = await this.studentFor(caller, studentId);
    const test = await this.answererTest(testId, caller.role === 'STUDENT' ? student : undefined);
    await this.prisma.$transaction(async (tx) => {
      const page = await tx.testAnswerPage.findFirst({
        where: { testId, studentId: student.id, uploadKey, pageNumber, versionId: null, uploadedById: caller.user.id }, select: { id: true, fileId: true },
      });
      if (!page) throw pageNotFound();
      await tx.testAnswerPage.delete({ where: { id: page.id } });
      await this.audit.log({
        actorId: caller.user.id, actorRole: caller.user.role, action: 'TEST_ANSWER_PAGE_REMOVED', entity: 'TestAnswerPage', entityId: page.id,
        metadata: { testId, subjectId: test.disciplineId, studentId: student.id, uploadKey, page: pageNumber, fileId: page.fileId },
      }, tx);
    });
    return this.pendingPages(caller, testId, student.id, uploadKey);
  }

  /** Commit a version (see the file header). Returns the caller's view and whether this was a replay of clientKey. */
  async submit(caller: Answerer, testId: string, studentId: string, dto: SubmitTestAnswerDto) {
    const student = await this.studentFor(caller, studentId);
    await this.answererTest(testId, caller.role === 'STUDENT' ? student : undefined);
    const submitter = this.submitterOf(caller);
    const typed = dto.typedAnswer !== undefined && dto.typedAnswer.trim().length > 0 ? dto.typedAnswer : null;

    const replayed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Test" WHERE "id" = ${testId} FOR SHARE`;
      const test = await tx.test.findUnique({ where: { id: testId } });
      if (!test || test.status !== 'PUBLISHED') throw testNotFound();
      const sub = await ensureSubmission(tx, testId, student.id);
      const again = await tx.testSubmissionVersion.findUnique({ where: { submissionId_clientKey: { submissionId: sub.id, clientKey: dto.clientKey } }, select: { id: true } });
      if (again) return true;

      const now = await this.deadlines.now(tx);
      assertEligible(test, student, now);
      // Phase 3 (G5): once marking began (any later status) nothing replaces the answer — whatever deadline still applies.
      if (sub.status !== 'SUBMITTED') {
        throw new AppError(HttpStatus.CONFLICT, 'SUBMISSION_LOCKED', 'This answer is already being marked, so it can no longer be replaced. If you must change it, ask your teacher or coach to request a resubmission.', { status: sub.status });
      }
      const deadline = await this.deadlines.forSubmission(tx, test, student.id, submitter);
      assertBeforeDeadline(now, deadline);
      // Locked after submission (checked after the deadline, the more final answer): another version needs an
      // Administrator's open authorization, used below.
      let authorizationId: string | null = null;
      if (sub.versionCount > 0) {
        const open = await tx.testResubmissionAuthorization.findFirst({ where: { submissionId: sub.id, ...OPEN_AUTHORIZATION }, select: { id: true } });
        if (!open) throw submittedAndLocked();
        authorizationId = open.id;
      }

      const pages = await tx.testAnswerPage.findMany({
        where: { testId, studentId: student.id, uploadKey: dto.clientKey, versionId: null }, select: { id: true, pageNumber: true, uploadedById: true },
      });
      if (pages.some((p) => p.uploadedById !== caller.user.id)) throw keyInUse();
      assertPagesComplete(pages.map((p) => p.pageNumber), dto.pageCount ?? (pages.length ? undefined : 0));
      assertAnswerFormat(test.answerFormat, typed, pages.length);

      const number = sub.versionCount + 1;
      const underExtension = now.getTime() > test.closesAt.getTime();
      const version = await tx.testSubmissionVersion.create({
        data: {
          submissionId: sub.id, number, clientKey: dto.clientKey,
          submittedById: caller.user.id, submitterRole: caller.role, teacherId: caller.role === 'TEACHER' ? caller.user.id : null,
          submittedAt: now, applicableDeadline: deadline.deadline, underExtension, extensionId: deadline.extensionId,
          typedAnswer: typed, pageCount: pages.length,
        },
        select: { id: true },
      });
      if (pages.length) await tx.testAnswerPage.updateMany({ where: { id: { in: pages.map((p) => p.id) }, versionId: null }, data: { versionId: version.id } });
      // The replacement uses the authorization: the answer is locked again.
      if (authorizationId) {
        const { count } = await tx.testResubmissionAuthorization.updateMany({
          where: { id: authorizationId, ...OPEN_AUTHORIZATION }, data: { usedAt: now, usedVersionId: version.id },
        });
        if (count === 0) throw submittedAndLocked();
      }
      await tx.testSubmission.update({
        where: { id: sub.id },
        data:  { currentVersionId: version.id, versionCount: number, lastSubmittedAt: now, ...(number === 1 && { firstSubmittedAt: now }) },
      });
      if (number === 1) {
        await tx.testSubmissionStatusChange.create({
          data: { submissionId: sub.id, fromStatus: null, toStatus: 'SUBMITTED', actorId: caller.user.id, actorRole: caller.user.role, createdAt: now },
        });
      }
      await this.audit.log({
        actorId: caller.user.id, actorRole: caller.user.role, action: number === 1 ? 'TEST_SUBMITTED' : 'TEST_SUBMISSION_REPLACED',
        entity: 'TestSubmission', entityId: sub.id,
        metadata: {
          testId, subjectId: test.disciplineId, studentId: student.id, versionId: version.id, version: number,
          submitterRole: caller.role, ...(caller.role === 'TEACHER' && { teacherId: caller.user.id }),
          submittedAt: now.toISOString(), deadline: deadline.deadline.toISOString(), underExtension, extensionId: deadline.extensionId,
          pages: pages.length, typedAnswer: typed !== null, ...(authorizationId && { resubmissionAuthorizationId: authorizationId }),
        },
      }, tx);
      return false;
    }, SUBMIT_TX);

    return { ...(await this.answererView(caller, testId, student)), replayed };
  }

  /** A page of one of the caller's (or their student's) versions, under a neutral name (page-3.jpg). */
  async sendAnswererPage(caller: Answerer, testId: string, studentId: string, versionId: string, pageNumber: number, res: Response, download: boolean) {
    const student = await this.studentFor(caller, studentId);
    const page = await this.prisma.testAnswerPage.findFirst({
      where: { versionId, pageNumber, version: { submission: { testId, studentId: student.id } } },
      select: { pageNumber: true, file: { select: { storageKey: true, mimeType: true, size: true } } },
    });
    if (!page) throw pageNotFound();
    await this.storage.send(res, { ...page.file, originalName: answerPageName(page.pageNumber, page.file.mimeType) }, { download });
  }

  /** The test paper for the people who answer it, once the test opened (a student: of their division). */
  async sendPaper(caller: Answerer, testId: string, res: Response, download: boolean) {
    const student = caller.role === 'STUDENT' ? await this.studentFor(caller, caller.user.id) : undefined;
    const test = await this.answererTest(testId, student);
    const now = await this.deadlines.now();
    if (test.opensAt.getTime() > now.getTime()) throw new AppError(HttpStatus.CONFLICT, 'TEST_NOT_OPEN', 'This test is not open yet. Check its opening date and come back then.', { opensAt: test.opensAt.toISOString() });
    const paper = test.files[0]?.file;
    if (!paper) throw new AppError(HttpStatus.NOT_FOUND, 'TEST_FILE_NOT_FOUND', 'This test has no question paper to download. Ask your teacher or coach.');
    await this.storage.send(res, { ...paper, originalName: neutralFileName('PAPER', paper.storageKey) }, { download });
  }

  // ── Administrators and Head Coaches: tracking and every version ────────────────

  /**
   * Submission tracking: every eligible student (and anyone who submitted) — submitted / not yet / late (blocked) /
   * under extension — with counts, filters (school, division, state, name) and pagination. A fixed number of queries.
   */
  async track(testId: string, q: ListTestSubmissionsQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const test = await this.prisma.test.findUniqueOrThrow({ where: { id: testId }, select: { id: true, closesAt: true, division: true, opensAt: true, status: true } });
    const now = await this.deadlines.now();
    const studentLevel: Submitter = { role: 'STUDENT' };
    const general = applicableDeadline(test.closesAt, await this.deadlines.activeExtensions(this.prisma, testId), '', studentLevel);
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const eligible: Prisma.UserWhereInput = {
      role: 'STUDENT', accountStatus: 'ACTIVE', isApproved: true, activatedAt: { not: null },
      ...(test.division !== 'ALL' && levelWhere(test.division)),
    };
    const population: Prisma.UserWhereInput = {
      AND: [
        { OR: [eligible, { testSubmissions: { some: { testId } } }] },
        ...(q.schoolId ? [{ schoolId: q.schoolId }] : []),
        ...(q.division ? [levelWhere(q.division)] : []),
        ...(contains ? [{ OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }] : []),
      ],
    };
    const extendedWhere: Prisma.UserWhereInput = general.extended ? {}
      : { testExtensionsAsStudent: { some: { testId, kind: 'STUDENT', cancelledAt: null, newDeadline: { gt: test.closesAt } } } };
    const filter = (s: (typeof q)['status']): Prisma.UserWhereInput =>
      s === 'UNDER_EXTENSION' ? extendedWhere : stateWhere(s!, testId, general.deadline, now);
    const where: Prisma.UserWhereInput = { AND: [population, ...(q.status ? [filter(q.status)] : [])] };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total, all, submitted, notSubmitted, lateBlocked, underExtension, submittedUnderExtension, submittedByTeacher] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, accountStatus: true, school: { select: { id: true, name: true } } },
      }),
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: population }),
      this.prisma.user.count({ where: { AND: [population, filter('SUBMITTED')] } }),
      this.prisma.user.count({ where: { AND: [population, filter('NOT_SUBMITTED')] } }),
      this.prisma.user.count({ where: { AND: [population, filter('LATE_BLOCKED')] } }),
      this.prisma.user.count({ where: { AND: [population, extendedWhere] } }),
      this.prisma.testSubmission.count({ where: { testId, currentVersion: { underExtension: true }, student: population } }),
      this.prisma.testSubmission.count({ where: { testId, currentVersion: { submitterRole: 'TEACHER' }, student: population } }),
    ]);
    const ids = rows.map((r) => r.id);
    const [subs, deadlines] = await Promise.all([
      ids.length ? this.prisma.testSubmission.findMany({ where: { testId, studentId: { in: ids } }, select: SUMMARY_SELECT }) : [],
      this.deadlines.forStudents(this.prisma, test, ids, studentLevel),
    ]);
    const subOf = new Map(subs.map((s) => [s.studentId, s]));
    const out = paginated(rows.map((s) => {
      const d = deadlines.get(s.id)!;
      const sub = subOf.get(s.id) ?? null;
      return {
        student: s, deadline: d.deadline, extended: d.extended, extensionKind: d.extensionKind, extensionId: d.extensionId,
        state: trackingState(sub !== null, now, d.deadline),
        submission: sub && staffSummary(sub),
      };
    }), total, page, limit);
    return {
      ...out,
      deadline: { closesAt: test.closesAt, general: general.deadline, extended: general.extended },
      counts: { students: all, submitted, notSubmitted, lateBlocked, underExtension, submittedUnderExtension, submittedByTeacher },
    };
  }

  /** One submission with EVERY version (submitter, teacher, time, deadline, under extension, pages) and its status history. */
  async staffDetail(testId: string, submissionId: string, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const sub = await this.prisma.testSubmission.findFirst({
      where: { id: submissionId, testId },
      select: {
        ...SUMMARY_SELECT,
        student: { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } },
        versions: { orderBy: { number: 'desc' }, select: VERSION_SELECT },
        statusChanges: { orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, actorRole: true, reason: true, createdAt: true, actor: PERSON } },
        test: { select: { closesAt: true } },
        resubmissionAuthorizations: { orderBy: { createdAt: 'desc' }, select: RESUBMISSION_SELECT },
      },
    });
    if (!sub) throw submissionNotFound();
    const d = await this.deadlines.forSubmission(this.prisma, { id: testId, closesAt: sub.test.closesAt }, sub.studentId, { role: 'STUDENT' });
    return {
      ...staffSummary(sub),
      student: sub.student,
      deadline: d.deadline, extended: d.extended, extensionKind: d.extensionKind, extensionId: d.extensionId,
      versions: sub.versions.map((v) => staffVersion(v)),
      statusHistory: sub.statusChanges,
      resubmissions: sub.resubmissionAuthorizations.map(resubmissionView),
      // The history above lists every authorization (used and cancelled too): the lock comes from the open one only.
      locked: sub.status !== 'SUBMITTED' || (sub.versionCount > 0 && !sub.resubmissionAuthorizations.some((r) => !r.usedAt && !r.cancelledAt)),
      resubmissionOpen: sub.resubmissionAuthorizations.some((r) => !r.usedAt && !r.cancelledAt),
    };
  }

  /**
   * An Administrator unlocks a submitted answer for ONE replacement (tests.authorizeResubmission; owner 2026-11-21), with
   * a reason. Under the submission's row lock (the same lock a submission takes): something must have been submitted,
   * marking must not have begun (409 SUBMISSION_IN_MARKING), and at most one authorization is open (409
   * RESUBMISSION_ALREADY_AUTHORIZED; a partial unique index too). The student, or a teacher of their school, may then
   * submit a replacement before the deadline that applies (an extension may be needed); it is locked again. Audited.
   */
  async authorizeResubmission(testId: string, submissionId: string, dto: AuthorizeResubmissionDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ id: string; studentId: string; status: string; versionCount: number }>>`
        SELECT "id", "studentId", "status"::text AS "status", "versionCount" FROM "TestSubmission"
         WHERE "id" = ${submissionId} AND "testId" = ${testId} FOR UPDATE`;
      if (!row) throw submissionNotFound();
      if (row.versionCount === 0) throw new AppError(HttpStatus.CONFLICT, 'NOTHING_SUBMITTED', 'Nothing has been submitted yet: there is nothing to unlock.');
      if (row.status !== 'SUBMITTED') {
        throw new AppError(HttpStatus.CONFLICT, 'SUBMISSION_IN_MARKING', 'Marking of this submission has begun; it can no longer be unlocked.', { status: row.status });
      }
      const open = await tx.testResubmissionAuthorization.findFirst({ where: { submissionId, ...OPEN_AUTHORIZATION }, select: { id: true } });
      if (open) throw new AppError(HttpStatus.CONFLICT, 'RESUBMISSION_ALREADY_AUTHORIZED', 'A resubmission is already authorized for this submission.', { id: open.id });
      const created = await tx.testResubmissionAuthorization.create({
        data: { submissionId, authorizedById: user.id, reason: dto.reason }, select: { id: true },
      });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_RESUBMISSION_AUTHORIZED', entity: 'TestSubmission', entityId: submissionId,
        metadata: { testId, studentId: row.studentId, authorizationId: created.id, reason: dto.reason, lockedVersion: row.versionCount },
      }, tx);
    });
    return this.staffDetail(testId, submissionId, user);
  }

  /** An Administrator withdraws an authorization not used yet (the answer is locked again). Audited. */
  async cancelResubmission(testId: string, submissionId: string, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ id: string; studentId: string }>>`
        SELECT "id", "studentId" FROM "TestSubmission" WHERE "id" = ${submissionId} AND "testId" = ${testId} FOR UPDATE`;
      if (!row) throw submissionNotFound();
      const open = await tx.testResubmissionAuthorization.findFirst({ where: { submissionId, ...OPEN_AUTHORIZATION }, select: { id: true } });
      if (!open) throw new AppError(HttpStatus.CONFLICT, 'NO_OPEN_RESUBMISSION', 'No resubmission is waiting to be used for this submission.');
      await tx.testResubmissionAuthorization.update({ where: { id: open.id }, data: { cancelledAt: new Date(), cancelledById: user.id } });
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_RESUBMISSION_CANCELLED', entity: 'TestSubmission', entityId: submissionId,
        metadata: { testId, studentId: row.studentId, authorizationId: open.id },
      }, tx);
    });
    return this.staffDetail(testId, submissionId, user);
  }

  async sendStaffPage(testId: string, submissionId: string, versionId: string, pageNumber: number, user: AuthUser, res: Response, download: boolean) {
    await this.tests.loadInScope(testId, user);
    const page = await this.prisma.testAnswerPage.findFirst({
      where: { versionId, pageNumber, version: { submissionId, submission: { testId } } },
      select: { pageNumber: true, file: { select: { storageKey: true, mimeType: true, size: true } } },
    });
    if (!page) throw pageNotFound();
    await this.storage.send(res, { ...page.file, originalName: answerPageName(page.pageNumber, page.file.mimeType) }, { download });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** The student's / teacher's view of a test and of the student's submission (no extension flag, ever). */
  private async answererView(caller: Answerer, testId: string, student: StudentRow) {
    const test = await this.answererTest(testId, caller.role === 'STUDENT' ? student : undefined);
    const now = await this.deadlines.now();
    const deadline = await this.deadlines.forSubmission(this.prisma, test, student.id, this.submitterOf(caller));
    const window = answerWindow(test.opensAt, deadline.deadline, now);
    const sub = await this.prisma.testSubmission.findUnique({
      where: { testId_studentId: { testId, studentId: student.id } },
      select: { status: true, versionCount: true, firstSubmittedAt: true, lastSubmittedAt: true, currentVersion: { select: { number: true } }, versions: { orderBy: { number: 'desc' }, select: VERSION_SELECT } },
    });
    const opened = window !== 'UPCOMING';
    const eligible = eligibilityProblems(test, student, now).length === 0;
    const open = sub && sub.versionCount > 0
      ? await this.prisma.testResubmissionAuthorization.findFirst({
          where: { submission: { testId, studentId: student.id }, ...OPEN_AUTHORIZATION }, select: { reason: true, createdAt: true },
        })
      : null;
    const locked = !!sub && (sub.status !== 'SUBMITTED' || (sub.versionCount > 0 && !open));
    return {
      test: {
        id: test.id, title: test.title, subject: test.discipline, division: test.division, answerFormat: test.answerFormat,
        maxMarks: test.maxMarks, opensAt: test.opensAt, deadline: deadline.deadline, window,
        hasPaper: opened && test.files.length > 0,
        paper: opened && test.files[0]
          ? { name: neutralFileName('PAPER', test.files[0].file.storageKey), mimeType: test.files[0].file.mimeType, size: test.files[0].file.size }
          : null,
        questions: opened ? test.questions : [],
      },
      student: { id: student.id, username: student.username, firstName: student.firstName, lastName: student.lastName, gradeLevel: student.gradeLevel, school: student.school },
      submission: sub && {
        status: sub.status, versionCount: sub.versionCount, firstSubmittedAt: sub.firstSubmittedAt, lastSubmittedAt: sub.lastSubmittedAt,
        currentVersion: sub.currentVersion?.number ?? null,
        versions: sub.versions.map((v) => answererVersion(v)),
      },
      // Locked after submission (owner 2026-11-21): a replacement only with an Administrator's open authorization.
      locked,
      resubmission: open ? { reason: open.reason, authorizedAt: open.createdAt } : null,
      canSubmit: eligible && window === 'OPEN' && !locked,
      limits: { maxPages: MAX_ANSWER_PAGES },
    };
  }

  /**
   * 409 SUBMISSION_LOCKED before a page is stored: marking began, or the answer was submitted and no Administrator's
   * authorization is open. (The submission itself checks again under the row lock; this only avoids useless uploads.)
   */
  private async assertAnswerOpen(testId: string, studentId: string) {
    const sub = await this.prisma.testSubmission.findUnique({
      where: { testId_studentId: { testId, studentId } },
      select: { status: true, versionCount: true, resubmissionAuthorizations: { where: OPEN_AUTHORIZATION, select: { id: true } } },
    });
    if (!sub) return;
    if (sub.status !== 'SUBMITTED') {
      throw new AppError(HttpStatus.CONFLICT, 'SUBMISSION_LOCKED', 'This answer is already being marked, so it can no longer be replaced. If you must change it, ask your teacher or coach to request a resubmission.', { status: sub.status });
    }
    if (sub.versionCount > 0 && sub.resubmissionAuthorizations.length === 0) throw submittedAndLocked();
  }

  /** 409 UPLOAD_ALREADY_SUBMITTED: a version already committed this key (start a new upload for a replacement). */
  private async assertKeyNotCommitted(tx: Tx, testId: string, studentId: string, uploadKey: string) {
    const done = await tx.testSubmissionVersion.findFirst({ where: { clientKey: uploadKey, submission: { testId, studentId } }, select: { id: true } });
    if (done) throw new AppError(HttpStatus.CONFLICT, 'UPLOAD_ALREADY_SUBMITTED', 'These pages were already submitted; start a new upload to replace them.');
  }
}

/** An authorization neither used nor cancelled. */
const OPEN_AUTHORIZATION = { usedAt: null, cancelledAt: null } as const;

/** 409 SUBMISSION_LOCKED: submitted, and no Administrator's authorization is open (owner 2026-11-21). */
const submittedAndLocked = () => new AppError(HttpStatus.CONFLICT, 'SUBMISSION_LOCKED',
  'This answer has been submitted and is locked. Only an administrator can allow it to be submitted again.', { reason: 'SUBMITTED' });

const RESUBMISSION_SELECT = {
  id: true, reason: true, createdAt: true, usedAt: true, cancelledAt: true,
  authorizedBy: PERSON, cancelledBy: PERSON, usedVersion: { select: { number: true } },
} as const satisfies Prisma.TestResubmissionAuthorizationSelect;

/** The history of unlocks: who authorized, why, when; used by which version, or cancelled by whom. */
function resubmissionView(r: Prisma.TestResubmissionAuthorizationGetPayload<{ select: typeof RESUBMISSION_SELECT }>) {
  return {
    id: r.id, reason: r.reason, authorizedAt: r.createdAt, authorizedBy: r.authorizedBy,
    state: r.usedAt ? 'USED' as const : r.cancelledAt ? 'CANCELLED' as const : 'OPEN' as const,
    usedAt: r.usedAt, usedVersion: r.usedVersion?.number ?? null, cancelledAt: r.cancelledAt, cancelledBy: r.cancelledBy,
  };
}

const keyInUse = () => new AppError(HttpStatus.CONFLICT, 'UPLOAD_KEY_IN_USE',
  'This upload belongs to someone else or was already submitted; start a new upload.');

/** The student's submission row, created if missing (opaque public code), locked FOR UPDATE for the transaction. */
async function ensureSubmission(tx: Tx, testId: string, studentId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = formatPublicCode(Array.from({ length: 8 }, () => randomInt(0, 31)));
    // DO NOTHING on ANY conflict: the student's row already exists (then it is read below), or — very rarely — the
    // random code is taken (then nothing exists yet and a new code is tried).
    await tx.$executeRaw`
      INSERT INTO "TestSubmission" ("id", "testId", "studentId", "publicCode", "status", "versionCount", "level", "createdAt", "updatedAt")
      VALUES (${randomUUID()}, ${testId}, ${studentId}, ${code}, 'SUBMITTED', 0,
              -- The student's Olympiad level now: the result's ranking group from here on (owner 2026-11-21).
              (SELECT d."code" FROM "User" u JOIN "Division" d ON d."id" = u."divisionId" WHERE u."id" = ${studentId}),
              (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))
      ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<Array<{ id: string; status: string; versionCount: number }>>`
      SELECT "id", "status"::text AS "status", "versionCount" FROM "TestSubmission"
       WHERE "testId" = ${testId} AND "studentId" = ${studentId} FOR UPDATE`;
    if (row) return row;
  }
  throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'SUBMISSION_CODE_UNAVAILABLE', 'Please try again.');
}

/** Tests by the caller's answer window (database time; the deadline includes the caller's applying extensions). */
function windowWhere(window: 'UPCOMING' | 'OPEN' | 'CLOSED' | undefined, now: Date, extensions: Prisma.TestExtensionWhereInput): Prisma.TestWhereInput {
  const extendedOpen: Prisma.TestWhereInput = { extensions: { some: { AND: [extensions, { newDeadline: { gte: now } }] } } };
  switch (window) {
    case 'UPCOMING': return { opensAt: { gt: now } };
    case 'OPEN':     return { opensAt: { lte: now }, OR: [{ closesAt: { gte: now } }, extendedOpen] };
    case 'CLOSED':   return { opensAt: { lte: now }, closesAt: { lt: now }, NOT: extendedOpen };
    default:         return {};
  }
}

/**
 * Students of a test by tracking state, given the deadline common to all of them (`general`: the test's closesAt with
 * the whole-test — and, for a teacher, their own — extension); a student's own extension can only make theirs later.
 */
function stateWhere(state: 'SUBMITTED' | 'NOT_SUBMITTED' | 'LATE_BLOCKED', testId: string, general: Date, now: Date): Prisma.UserWhereInput {
  const has: Prisma.UserWhereInput = { testSubmissions: { some: { testId } } };
  const ownOpen: Prisma.UserWhereInput = { testExtensionsAsStudent: { some: { testId, kind: 'STUDENT', cancelledAt: null, newDeadline: { gte: now } } } };
  const generalOpen = general.getTime() >= now.getTime();
  switch (state) {
    case 'SUBMITTED':     return has;
    case 'NOT_SUBMITTED': return generalOpen ? { NOT: has } : { AND: [{ NOT: has }, ownOpen] };
    case 'LATE_BLOCKED':  return generalOpen ? { id: { in: [] } } : { AND: [{ NOT: has }, { NOT: ownOpen }] };
  }
}

function pagesView(pages: VersionRow['pages']) {
  return pages.map((p) => ({ page: p.pageNumber, name: answerPageName(p.pageNumber, p.file.mimeType), mimeType: p.file.mimeType, size: p.file.size }));
}

/** A version as the student or a teacher sees it: who submitted it and when, the answer — no deadline or extension mark. */
function answererVersion(v: VersionRow) {
  return {
    id: v.id, number: v.number, submittedAt: v.submittedAt, submitterRole: v.submitterRole,
    submittedBy: { firstName: v.submittedBy.firstName, lastName: v.submittedBy.lastName },
    typedAnswer: v.typedAnswer, pageCount: v.pageCount, pages: pagesView(v.pages),
  };
}

/** Administrators and Head Coaches: everything, including the deadline that applied and the under-extension mark. */
function staffVersion(v: VersionRow) {
  return {
    id: v.id, number: v.number, submittedAt: v.submittedAt, submitterRole: v.submitterRole,
    submittedBy: v.submittedBy, teacher: v.teacher,
    applicableDeadline: v.applicableDeadline, underExtension: v.underExtension, extensionId: v.extensionId,
    typedAnswer: v.typedAnswer, pageCount: v.pageCount, pages: pagesView(v.pages),
  };
}

function answererSummary(s: SummaryRow) {
  return {
    status: s.status, versionCount: s.versionCount, lastSubmittedAt: s.lastSubmittedAt,
    lastSubmitterRole: s.currentVersion?.submitterRole ?? null,
    // Locked after submission unless an Administrator's authorization is open (owner 2026-11-21).
    locked: s.status !== 'SUBMITTED' || (s.versionCount > 0 && s.resubmissionAuthorizations.length === 0),
    resubmissionOpen: s.resubmissionAuthorizations.length > 0,
  };
}

function staffSummary(s: SummaryRow) {
  return {
    id: s.id, publicCode: s.publicCode, status: s.status, versionCount: s.versionCount,
    firstSubmittedAt: s.firstSubmittedAt, lastSubmittedAt: s.lastSubmittedAt,
    // Locked after submission unless an Administrator's authorization is open (owner 2026-11-21).
    locked: s.versionCount > 0 && s.resubmissionAuthorizations.length === 0,
    resubmissionOpen: s.resubmissionAuthorizations.length > 0,
    current: s.currentVersion && {
      number: s.currentVersion.number, submittedAt: s.currentVersion.submittedAt, submitterRole: s.currentVersion.submitterRole,
      submittedBy: s.currentVersion.submittedBy, teacher: s.currentVersion.teacher, underExtension: s.currentVersion.underExtension,
    },
  };
}

export type { ApplicableDeadline };
