/**
 * Test Management (WS3, Phase 4): published results as students and teachers see them, and the role dashboards
 * (owner spec 10.2 and 12).
 *
 *   Student (tests.viewOwnResults, own)     their OWN published results: marks per question (where the test has
 *                                           questions), the total, the comments of the FINAL marking — never who marked,
 *                                           never another marking, never a rank (STUDENT_RANKINGS_ENABLED is false).
 *   Teacher (tests.viewSchoolResults,       published results of the ACTIVE students (current claim) of their own ACTIVE
 *            school)                        schools and assigned to them (teacher-scope.ts teacherTestStudentsWhere) — never a rank, never
 *                                           another school's student (404, not revealed).
 * A result is visible only while it is PUBLISHED: an unapproved, approved-but-unpublished or withdrawn (G6) result is
 * not found (404 RESULT_NOT_FOUND), never "hidden". Responses are built from whitelists and checked by assertResultSafe.
 *
 * Dashboards: students (tests.submit), teachers (tests.submitForStudents), Administrators / Head Coaches (tests.view, the
 * subjects they head), coaches (tests.mark: test-marker.service.ts dashboard). Fixed number of queries each.
 */
import { HttpStatus, Injectable } from '@nestjs/common';

import { AccessService } from '../common/access/access.service.js';
import { isStudent, isTeacher, unsupportedRole } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { teacherTestStudentsWhere } from '../teachers/teacher-scope.js';
import type { MyResultsQueryDto, SchoolResultsQueryDto } from './dto/results.dto.js';
import { assertResultSafe, resultView, studentRankingsVisible } from './results-rules.js';
import { rankingPage } from './results-store.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { TestSubmissionsService } from './test-submissions.service.js';
import { subjectFilter } from './test-rules.js';
import { TestsService } from './tests.service.js';
import { countsOf } from './test-results.service.js';

const resultNotFound = () => new AppError(HttpStatus.NOT_FOUND, 'RESULT_NOT_FOUND', 'No published result for this test.');
const TEST_SUMMARY = { id: true, title: true, division: true, maxMarks: true, discipline: { select: { id: true, code: true, name: true } } } as const;
const FINAL_SELECT = { totalMarks: true, comment: true, scores: { select: { questionId: true, marks: true, comment: true } } } as const;
const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;

@Injectable()
export class TestResultViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly deadlines: TestDeadlineService,
    private readonly tests: TestsService,
    private readonly submissions: TestSubmissionsService,
  ) {}

  // ── Student: my results ────────────────────────────────────────────────────────

  /** My published results, newest first: the test and my total. */
  async myResults(user: AuthUser, q: MyResultsQueryDto) {
    if (!isStudent(user)) throw unsupportedRole();
    const where: Prisma.TestSubmissionWhereInput = { studentId: user.id, status: 'PUBLISHED' };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.testSubmission.findMany({
        where, skip, take, orderBy: [{ publishedAt: 'desc' }, { id: 'asc' }],
        select: { publishedAt: true, test: { select: TEST_SUMMARY }, finalMarking: { select: { totalMarks: true } } },
      }),
      this.prisma.testSubmission.count({ where }),
    ]);
    const out = paginated(rows.map((r) => ({
      test: { id: r.test.id, title: r.test.title, division: r.test.division, subject: r.test.discipline },
      totalMarks: r.finalMarking?.totalMarks ?? null, maxMarks: r.test.maxMarks, publishedAt: r.publishedAt,
    })), total, page, limit);
    assertResultSafe(out);
    return out;
  }

  /** My published result for one test: per question, total, comments (final marking only). */
  async myResult(user: AuthUser, testId: string) {
    if (!isStudent(user)) throw unsupportedRole();
    return this.publishedResult(testId, user.id, 'STUDENT');
  }

  // ── Teacher: my school's results ──────────────────────────────────────────────

  /** Tests with published results of my schools' students, with how many (never an average or a rank). */
  async schoolTests(user: AuthUser, q: MyResultsQueryDto) {
    const schools = await this.teacherSchools(user);
    const students = teacherTestStudentsWhere(user.id, schools);
    const where: Prisma.TestWhereInput = { submissions: { some: { status: 'PUBLISHED', student: students } } };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.test.findMany({ where, skip, take, orderBy: [{ closesAt: 'desc' }, { id: 'asc' }], select: { ...TEST_SUMMARY, closesAt: true } }),
      this.prisma.test.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await this.prisma.testSubmission.groupBy({ by: ['testId'], where: { testId: { in: ids }, status: 'PUBLISHED', student: students }, _count: { _all: true }, _max: { publishedAt: true } })
      : [];
    const out = paginated(rows.map((t) => {
      const c = counts.find((x) => x.testId === t.id);
      return {
        test: { id: t.id, title: t.title, division: t.division, subject: t.discipline, closesAt: t.closesAt }, maxMarks: t.maxMarks,
        publishedResults: c?._count._all ?? 0, lastPublishedAt: c?._max.publishedAt ?? null,
      };
    }), total, page, limit);
    assertResultSafe(out);
    return out;
  }

  /** One test: the published results of my schools' students, by name (never ordered by marks, never ranked). */
  async schoolResults(user: AuthUser, testId: string, q: SchoolResultsQueryDto) {
    const schools = await this.teacherSchools(user);
    if (q.schoolId && !schools.includes(q.schoolId) && !(await this.prisma.user.count({ where: teacherTestStudentsWhere(user.id, schools, q.schoolId) }))) {
      throw new AppError(HttpStatus.NOT_FOUND, 'SCHOOL_NOT_FOUND', 'School not found.');
    }
    const test = await this.prisma.test.findUnique({ where: { id: testId }, select: { ...TEST_SUMMARY, status: true } });
    if (!test || test.status !== 'PUBLISHED') throw resultNotFound();
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.TestSubmissionWhereInput = {
      testId, status: 'PUBLISHED',
      student: { AND: [teacherTestStudentsWhere(user.id, schools, q.schoolId), ...(contains ? [{ OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }] : [])] },
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.testSubmission.findMany({
        where, skip, take, orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }, { id: 'asc' }],
        select: {
          publishedAt: true, finalMarking: { select: { totalMarks: true } },
          student: { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.testSubmission.count({ where }),
    ]);
    const out = {
      test: { id: test.id, title: test.title, division: test.division, subject: test.discipline, maxMarks: test.maxMarks },
      ...paginated(rows.map((r) => ({ student: r.student, totalMarks: r.finalMarking?.totalMarks ?? null, maxMarks: test.maxMarks, publishedAt: r.publishedAt })), total, page, limit),
    };
    assertResultSafe(out);
    return out;
  }

  /** One of my schools' students: their published result (per question, total, comments). */
  async schoolResult(user: AuthUser, testId: string, studentId: string) {
    const schools = await this.teacherSchools(user);
    const visible = await this.prisma.user.findFirst({ where: { AND: [{ id: studentId }, teacherTestStudentsWhere(user.id, schools)] }, select: { id: true } });
    if (!visible) throw resultNotFound();
    return this.publishedResult(testId, studentId, 'TEACHER');
  }

  // ── Coach: the published results of my programmes (owner 2026-11-23) ─────────────────

  /** The subjects whose results a Coach sees: their programmes, unless RESULTS was taken away (403 for anyone else). */
  private async coachResultSubjects(user: AuthUser): Promise<string[]> {
    if (user.role !== 'MENTOR') throw unsupportedRole();
    return this.access.coachProgrammes(user, 'RESULTS');
  }

  /** Tests of my programmes' subjects with published results, with how many (never an average or a rank). */
  async coachTests(user: AuthUser, q: MyResultsQueryDto) {
    const subjects = await this.coachResultSubjects(user);
    const where: Prisma.TestWhereInput = { disciplineId: { in: subjects }, submissions: { some: { status: 'PUBLISHED' } } };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.test.findMany({ where, skip, take, orderBy: [{ closesAt: 'desc' }, { id: 'asc' }], select: { ...TEST_SUMMARY, closesAt: true } }),
      this.prisma.test.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const counts = ids.length
      ? await this.prisma.testSubmission.groupBy({ by: ['testId'], where: { testId: { in: ids }, status: 'PUBLISHED' }, _count: { _all: true }, _max: { publishedAt: true } })
      : [];
    const out = paginated(rows.map((t) => {
      const c = counts.find((x) => x.testId === t.id);
      return {
        test: { id: t.id, title: t.title, division: t.division, subject: t.discipline, closesAt: t.closesAt }, maxMarks: t.maxMarks,
        publishedResults: c?._count._all ?? 0, lastPublishedAt: c?._max.publishedAt ?? null,
      };
    }), total, page, limit);
    assertResultSafe(out);
    return out;
  }

  /** One test of my programmes: its published results by name, every level (never ordered by marks, never ranked). */
  async coachResults(user: AuthUser, testId: string, q: SchoolResultsQueryDto) {
    const subjects = await this.coachResultSubjects(user);
    const test = await this.prisma.test.findUnique({ where: { id: testId }, select: { ...TEST_SUMMARY, status: true, disciplineId: true } });
    if (!test || test.status !== 'PUBLISHED' || !subjects.includes(test.disciplineId)) throw resultNotFound();
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.TestSubmissionWhereInput = {
      testId, status: 'PUBLISHED',
      student: { AND: [
        ...(q.schoolId ? [{ schoolId: q.schoolId }] : []),
        ...(contains ? [{ OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }] : []),
      ] },
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.testSubmission.findMany({
        where, skip, take, orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }, { id: 'asc' }],
        select: {
          publishedAt: true, finalMarking: { select: { totalMarks: true } },
          student: { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.testSubmission.count({ where }),
    ]);
    const out = {
      test: { id: test.id, title: test.title, division: test.division, subject: test.discipline, maxMarks: test.maxMarks },
      ...paginated(rows.map((r) => ({ student: r.student, totalMarks: r.finalMarking?.totalMarks ?? null, maxMarks: test.maxMarks, publishedAt: r.publishedAt })), total, page, limit),
    };
    assertResultSafe(out);
    return out;
  }

  /** One student's published result in a test of my programmes (per question, total, comments). */
  async coachResult(user: AuthUser, testId: string, studentId: string) {
    const subjects = await this.coachResultSubjects(user);
    const test = await this.prisma.test.findUnique({ where: { id: testId }, select: { disciplineId: true } });
    if (!test || !subjects.includes(test.disciplineId)) throw resultNotFound();
    return this.publishedResult(testId, studentId, 'TEACHER');
  }

  // ── Dashboards ────────────────────────────────────────────────────────────────

  /** Student (spec 12.5): open and upcoming tests with MY deadline (extension included), submissions, published results. */
  async studentDashboard(user: AuthUser) {
    if (!isStudent(user)) throw unsupportedRole();
    const [open, upcoming, submitted, results] = await Promise.all([
      this.submissions.listMine(user, { window: 'OPEN', page: 1, limit: 5 }),
      this.submissions.listMine(user, { window: 'UPCOMING', page: 1, limit: 5 }),
      this.prisma.testSubmission.groupBy({ by: ['status'], where: { studentId: user.id }, _count: { _all: true } }),
      this.myResults(user, { page: 1, limit: 5 }),
    ]);
    const total = submitted.reduce((a, b) => a + b._count._all, 0);
    const published = submitted.find((s) => s.status === 'PUBLISHED')?._count._all ?? 0;
    return {
      open: open.data, upcoming: upcoming.data,
      counts: { open: open.meta.total, upcoming: upcoming.meta.total, submitted: total, awaitingResults: total - published, publishedResults: results.meta.total },
      results: results.data,
    };
  }

  /** Teacher (spec 12.4): open tests with my students submitted / missing, my extensions, published results of my schools. */
  async teacherDashboard(user: AuthUser) {
    const schools = await this.teacherSchools(user);
    const now = await this.deadlines.now();
    const [open, results, extensions] = await Promise.all([
      this.submissions.listForTeacher(user, { window: 'OPEN', page: 1, limit: 5 }),
      this.schoolTests(user, { page: 1, limit: 5 }),
      this.prisma.testExtension.findMany({
        where: { cancelledAt: null, newDeadline: { gt: now }, test: { status: 'PUBLISHED' },
          OR: [{ kind: 'TEACHER', teacherId: user.id }, { kind: 'STUDENT', student: teacherTestStudentsWhere(user.id, schools) }] },
        orderBy: [{ newDeadline: 'asc' }, { id: 'asc' }], take: 20,
        select: { id: true, kind: true, newDeadline: true, test: { select: { id: true, title: true } }, student: PERSON },
      }),
    ]);
    return {
      open: open.data.map((t) => ({ ...t, missing: Math.max(0, t.students - t.submitted) })),
      counts: { openTests: open.meta.total, testsWithResults: results.meta.total, activeExtensions: extensions.length },
      /** Extensions that apply to me (my own) or to students of my schools (their own deadline). */
      extensions,
      results: results.data,
    };
  }

  /**
   * Administrator / Head Coach (spec 12.1, 12.3): per subject in scope — tests, submissions by status, active extensions,
   * authorised markers, Head Coaches; the latest tests' progress (marking, approval, publication); progress per coach;
   * the internal ranking (top 5) of the latest test with published results.
   */
  async staffDashboard(user: AuthUser) {
    const scope = await this.tests.scope(user);
    const now = await this.deadlines.now();
    const inScope = subjectFilter(scope);
    const subjectIds = scope === 'all' ? null : [...scope];
    const [subjects, tests, testCounts, subByStatus, extensions, markers, heads, coachRows] = await Promise.all([
      this.prisma.discipline.findMany({ where: { isActive: true, ...(subjectIds && { id: { in: subjectIds } }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }], select: { id: true, code: true, name: true } }),
      this.prisma.test.findMany({
        where: inScope, orderBy: [{ closesAt: 'desc' }, { id: 'asc' }], take: 10,
        select: { id: true, title: true, status: true, closesAt: true, disciplineId: true, discipline: { select: { id: true, code: true, name: true } } },
      }),
      this.prisma.test.groupBy({ by: ['disciplineId', 'status'], where: inScope, orderBy: { disciplineId: 'asc' }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ disciplineId: string; status: string; n: number }>>`
        SELECT t."disciplineId", s."status"::text AS "status", count(*)::int AS "n"
          FROM "TestSubmission" s JOIN "Test" t ON t."id" = s."testId"
         WHERE (${subjectIds}::text[] IS NULL OR t."disciplineId" = ANY(${subjectIds}::text[]))
         GROUP BY t."disciplineId", s."status"`,
      this.prisma.$queryRaw<Array<{ disciplineId: string; n: number }>>`
        SELECT t."disciplineId", count(*)::int AS "n" FROM "TestExtension" e JOIN "Test" t ON t."id" = e."testId"
         WHERE e."cancelledAt" IS NULL AND e."newDeadline" > ${now} AND (${subjectIds}::text[] IS NULL OR t."disciplineId" = ANY(${subjectIds}::text[]))
         GROUP BY t."disciplineId"`,
      // Coaches who may mark each subject (marker-reach.ts): authorised or members of its programme, ACTIVE, not restricted.
      this.prisma.$queryRaw<Array<{ disciplineId: string; n: number }>>`
        SELECT d."id" AS "disciplineId", count(DISTINCT u."id")::int AS "n"
          FROM "Discipline" d JOIN "User" u ON u."role" = 'MENTOR' AND u."accountStatus" = 'ACTIVE'
         WHERE (${subjectIds}::text[] IS NULL OR d."id" = ANY(${subjectIds}::text[]))
           AND (EXISTS (SELECT 1 FROM "MarkerAuthorization" a WHERE a."coachId" = u."id" AND a."disciplineId" = d."id" AND a."revokedAt" IS NULL)
             OR EXISTS (SELECT 1 FROM "ProgrammeMembership" pm WHERE pm."userId" = u."id" AND pm."disciplineId" = d."id" AND pm."isActive"))
           AND NOT EXISTS (SELECT 1 FROM "CoachProgrammeRestriction" r WHERE r."coachId" = u."id" AND r."disciplineId" = d."id" AND r."capability" = 'MARKING' AND r."liftedAt" IS NULL)
         GROUP BY d."id"`,
      this.prisma.$queryRaw<Array<{ disciplineId: string; n: number }>>`
        SELECT m."disciplineId", count(DISTINCT m."userId")::int AS "n" FROM "ProgrammeMembership" m JOIN "User" u ON u."id" = m."userId"
         WHERE m."isActive" AND u."role" = 'HEAD_COACH' AND (${subjectIds}::text[] IS NULL OR m."disciplineId" = ANY(${subjectIds}::text[]))
         GROUP BY m."disciplineId"`,
      this.prisma.$queryRaw<Array<{ coachId: string; firstName: string; lastName: string; assigned: number; notStarted: number; inProgress: number; marked: number; returned: number }>>`
        SELECT a."coachId", u."firstName", u."lastName", count(*)::int AS "assigned",
               count(*) FILTER (WHERE m."id" IS NULL)::int AS "notStarted",
               count(*) FILTER (WHERE m."status" IN ('DRAFT', 'RETURNED'))::int AS "inProgress",
               count(*) FILTER (WHERE m."status" IN ('SUBMITTED', 'APPROVED'))::int AS "marked",
               count(*) FILTER (WHERE m."status" = 'RETURNED')::int AS "returned"
          FROM "TestMarkerAssignment" a
          JOIN "TestSubmission" s ON s."id" = a."submissionId" JOIN "Test" t ON t."id" = s."testId"
          JOIN "User" u ON u."id" = a."coachId"
          LEFT JOIN "TestMarking" m ON m."assignmentId" = a."id"
         WHERE a."endedAt" IS NULL AND (${subjectIds}::text[] IS NULL OR t."disciplineId" = ANY(${subjectIds}::text[]))
         GROUP BY a."coachId", u."firstName", u."lastName"
         ORDER BY count(*) FILTER (WHERE m."id" IS NULL OR m."status" IN ('DRAFT', 'RETURNED')) DESC, u."lastName", a."coachId"
         LIMIT 20`,
    ]);
    const ids = tests.map((t) => t.id);
    const [perTest, extPerTest, pubs, latestPublished] = await Promise.all([
      ids.length ? this.prisma.testSubmission.groupBy({ by: ['testId', 'status'], where: { testId: { in: ids } }, orderBy: { testId: 'asc' }, _count: { _all: true } }) : [],
      ids.length ? this.prisma.testExtension.groupBy({ by: ['testId'], where: { testId: { in: ids }, cancelledAt: null, newDeadline: { gt: now } }, orderBy: { testId: 'asc' }, _count: { _all: true } }) : [],
      ids.length ? this.prisma.testPublication.groupBy({ by: ['testId'], where: { testId: { in: ids } }, orderBy: { testId: 'asc' }, _max: { createdAt: true }, _count: { _all: true } }) : [],
      this.prisma.testPublication.findFirst({ where: { test: inScope }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], select: { test: { select: { id: true, title: true, maxMarks: true } } } }),
    ]);
    const top = latestPublished
      ? (await rankingPage(this.prisma, latestPublished.test.id, { by: 'overall', publishedOnly: true }, 0, 5)).rows
      : [];
    const sumStatus = (rows: Array<{ status: string; n: number }>) => countsOf(rows.map((r) => ({ status: r.status, _count: { _all: r.n } })));
    return {
      scope: scope === 'all' ? 'all' : 'subjects',
      now,
      subjects: subjects.map((s) => {
        const sc = testCounts.filter((c) => c.disciplineId === s.id);
        const counts = sumStatus(subByStatus.filter((r) => r.disciplineId === s.id));
        return {
          subject: s,
          tests: { draft: (sc.find((c) => c.status === 'DRAFT')?._count as { _all: number } | undefined)?._all ?? 0, published: (sc.find((c) => c.status === 'PUBLISHED')?._count as { _all: number } | undefined)?._all ?? 0 },
          submissions: counts,
          pendingReview: counts.byStatus.MARKED ?? 0, returned: counts.byStatus.RETURNED ?? 0, awaitingSecondMarking: counts.byStatus.AWAITING_SECOND_MARKING ?? 0,
          readyToPublish: counts.approved,
          activeExtensions: extensions.find((e) => e.disciplineId === s.id)?.n ?? 0,
          authorisedMarkers: markers.find((m) => m.disciplineId === s.id)?.n ?? 0,
          headCoaches: heads.find((h) => h.disciplineId === s.id)?.n ?? 0,
        };
      }),
      tests: tests.map((t) => {
        const counts = countsOf(perTest.filter((p) => p.testId === t.id) as Array<{ status: string; _count: { _all: number } }>);
        const p = pubs.find((x) => x.testId === t.id);
        return {
          id: t.id, title: t.title, status: t.status, closesAt: t.closesAt, subject: t.discipline, counts,
          activeExtensions: (extPerTest.find((e) => e.testId === t.id)?._count as { _all: number } | undefined)?._all ?? 0,
          publications: (p?._count as { _all: number } | undefined)?._all ?? 0, lastPublishedAt: p?._max?.createdAt ?? null,
        };
      }),
      coaches: coachRows.map((c) => ({ coach: { id: c.coachId, firstName: c.firstName, lastName: c.lastName }, assigned: c.assigned, notStarted: c.notStarted, inProgress: c.inProgress, marked: c.marked, returned: c.returned })),
      rankings: latestPublished && {
        test: latestPublished.test,
        top: top.map((r) => ({ rank: r.rank, totalMarks: r.totalMarks, student: { id: r.studentId, firstName: r.firstName, lastName: r.lastName }, school: r.schoolName })),
      },
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async teacherSchools(user: AuthUser): Promise<string[]> {
    if (!isTeacher(user)) throw unsupportedRole();
    return this.access.teacherSchools(user);
  }

  /** The PUBLISHED result of this student for this test, as a whitelist — else 404 (unpublished, withdrawn, none). */
  private async publishedResult(testId: string, studentId: string, audience: 'STUDENT' | 'TEACHER') {
    const sub = await this.prisma.testSubmission.findUnique({
      where: { testId_studentId: { testId, studentId } },
      select: {
        status: true, publishedAt: true, finalMarking: { select: FINAL_SELECT },
        student: audience === 'TEACHER' ? { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } } : false,
        test: { select: { ...TEST_SUMMARY, studentRankingsVisible: true, questions: { orderBy: { order: 'asc' }, select: { id: true, order: true, prompt: true, maxMarks: true } } } },
      },
    });
    if (!sub || sub.status !== 'PUBLISHED' || !sub.finalMarking) throw resultNotFound();
    // Design only (owner spec 10.3): a rank would be added here for students only if studentRankingsVisible() — never
    // true in this release (STUDENT_RANKINGS_ENABLED is false; a CHECK refuses the column). Nothing is sent about it.
    if (studentRankingsVisible(sub.test)) throw new Error('Student rankings are not enabled in this release.');
    const out = {
      test: { id: sub.test.id, title: sub.test.title, division: sub.test.division, subject: sub.test.discipline, maxMarks: sub.test.maxMarks },
      ...(audience === 'TEACHER' && { student: sub.student }),
      publishedAt: sub.publishedAt,
      result: resultView(sub.test.questions, sub.test.maxMarks, sub.finalMarking),
    };
    assertResultSafe(out);
    return out;
  }
}
