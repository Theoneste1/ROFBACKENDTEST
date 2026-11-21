/**
 * Test Management (WS3, Phase 4): results publication, results with identity, internal rankings and reports — for
 * Administrators (every subject) and the subject's Head Coaches (TestsService.loadInScope; another subject: 403
 * SCOPE_FORBIDDEN). Students and Teachers: test-result-views.service.ts. Coaches: nothing here.
 *
 * Publication (tests.publishResults; the override: tests.overridePublication — Administrators only)
 *   The preview shows the counts (submissions by status, approved and waiting, already published, unapproved), the list
 *   of unapproved results, and the extensions still running (more answers may arrive: a warning, never a block). Publishing
 *   takes the test's row lock (concurrent requests run one after the other), locks the APPROVED results and moves each
 *   APPROVED → PUBLISHED (the transition table, with status history) under ONE publication record; only approved results
 *   are ever published. With unapproved results a Head Coach is blocked (409 PUBLICATION_BLOCKED) and only an
 *   Administrator may override, with a mandatory reason (audited separately as TEST_PUBLICATION_OVERRIDDEN). A retried or
 *   concurrent request with nothing new to publish returns the latest publication (replayed: true) — no second record,
 *   no second notice. The students and their schools' teachers are told in the SAME transaction (outbox rows with dedupe
 *   keys; one notice per teacher per publication), sent after commit.
 *
 * G6 (withdrawal on unlock) lives with the unlock decision (test-marking.service.ts → withdrawPublished).
 *
 * Rankings (tests.viewRankings): internal only — competition rank within the test, a division or a school
 * (results-rules.ts, results-store.ts rankingPage). Reports and CSV exports (tests.viewResults): counts, average, median,
 * distribution, per-question averages, per school and per division. Every list is paginated and read in a fixed number
 * of queries.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import type { Response } from 'express';

import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { isAdmin } from '../common/access/roles.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { DecisionEvents } from '../decision-notifications/decision-content.js';
import { DecisionNotificationsService } from '../decision-notifications/decision-notifications.service.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { csvFromRows, type CsvValue } from '../reports/csv.js';
import { sendCsvExport } from '../reports/csv-stream.js';
import type {
  ListTestResultsQueryDto, OverridePublicationDto, PublicationPreviewQueryDto, PublicationsQueryDto, PublishTestResultsDto, RankingsQueryDto,
  ResultsExportQueryDto, ResultsReportQueryDto, TestReportsQueryDto,
} from './dto/results.dto.js';
import type { SubmissionStatus } from './marking-rules.js';
import type { Actor } from './marking-store.js';
import { UNAPPROVED_STATUSES, average, decidePublication, distributionBands, median } from './results-rules.js';
import {
  activeStudents, allResults, lockApproved, publishApproved, questionAverages, rankingPage, resultNotices, schoolTeachersOf,
  type ResultRow,
} from './results-store.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { subjectFilter } from './test-rules.js';
import { TestsService, lockTest } from './tests.service.js';

/** Publishing thousands of results: one transaction, a few set-based statements; room to wait for the test lock. */
const PUBLISH_TX = { maxWait: 15_000, timeout: 120_000 } as const;
const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;
const PUBLICATION_SELECT = {
  id: true, number: true, actorRole: true, override: true, overrideReason: true, publishedCount: true, counts: true, createdAt: true,
  publishedBy: PERSON, _count: { select: { withdrawals: true } },
} as const satisfies Prisma.TestPublicationSelect;

type Tx = Prisma.TransactionClient;

@Injectable()
export class TestResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly deadlines: TestDeadlineService,
    private readonly tests: TestsService,
    private readonly notices: DecisionNotificationsService,
  ) {}

  // ── Publication (tests.publishResults) ────────────────────────────────────────

  /**
   * Before publishing: counts, the unapproved results (paginated, with identity and status), the extensions still
   * running, and what the caller may do now (publish; override — Administrators only).
   */
  async preview(testId: string, q: PublicationPreviewQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const now = await this.deadlines.now();
    const test = await this.prisma.test.findUniqueOrThrow({
      where: { id: testId },
      select: { id: true, title: true, status: true, maxMarks: true, closesAt: true, discipline: { select: { id: true, code: true, name: true } } },
    });
    const { page, limit, skip, take } = pageArgs(q);
    const unapprovedWhere: Prisma.TestSubmissionWhereInput = { testId, status: { in: [...UNAPPROVED_STATUSES] } };
    const [byStatus, unapproved, unapprovedTotal, extensions, publications, latest] = await this.prisma.$transaction([
      this.prisma.testSubmission.groupBy({ by: ['status'], where: { testId }, orderBy: { status: 'asc' }, _count: { _all: true } }),
      this.prisma.testSubmission.findMany({
        where: unapprovedWhere, skip, take, orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }, { id: 'asc' }],
        select: { id: true, publicCode: true, status: true, updatedAt: true, student: { select: { id: true, username: true, firstName: true, lastName: true, school: { select: { id: true, name: true } } } } },
      }),
      this.prisma.testSubmission.count({ where: unapprovedWhere }),
      this.prisma.testExtension.findMany({
        where: { testId, cancelledAt: null, newDeadline: { gt: now } }, orderBy: [{ newDeadline: 'desc' }, { id: 'asc' }], take: 200,
        select: { id: true, kind: true, newDeadline: true, reason: true, student: PERSON, teacher: PERSON },
      }),
      this.prisma.testPublication.count({ where: { testId } }),
      this.prisma.testPublication.findFirst({ where: { testId }, orderBy: { number: 'desc' }, select: PUBLICATION_SELECT }),
    ]);
    const counts = countsOf(byStatus);
    const mayOverride = isAdmin(user);
    return {
      test, now,
      deadlinePassed: test.closesAt.getTime() < now.getTime(),
      counts,
      unapproved: paginated(unapproved, unapprovedTotal, page, limit),
      /** Extensions still running: more answers may arrive after this publication (a warning). */
      activeExtensions: extensions,
      warnings: [
        ...(counts.unapproved > 0 ? ['UNAPPROVED_RESULTS'] : []),
        ...(extensions.some((e) => e.kind !== 'TEST') ? ['ACTIVE_INDIVIDUAL_EXTENSIONS'] : []),
        ...(extensions.some((e) => e.kind === 'TEST') ? ['ACTIVE_TEST_EXTENSION'] : []),
        ...(test.closesAt.getTime() >= now.getTime() ? ['DEADLINE_NOT_PASSED'] : []),
      ],
      publications, latestPublication: latest && publicationView(latest),
      actions: {
        publish: counts.approved > 0 && counts.unapproved === 0,
        /** Some results are not approved: blocked unless an Administrator overrides (publishing the approved ones only). */
        blocked: counts.approved > 0 && counts.unapproved > 0 && !mayOverride,
        override: mayOverride && counts.approved > 0 && counts.unapproved > 0,
      },
    };
  }

  /** Publish the approved results (no override: blocked while any result is unapproved). */
  publish(testId: string, dto: PublishTestResultsDto, user: AuthUser) {
    return this.doPublish(testId, { override: false, reason: null, clientKey: dto.clientKey }, user);
  }

  /** Administrators: publish the approved results although some are not approved (mandatory reason, audited). */
  publishWithOverride(testId: string, dto: OverridePublicationDto, user: AuthUser) {
    if (!isAdmin(user)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'OVERRIDE_NOT_ALLOWED', 'Only an Administrator can override the publication checks.');
    }
    return this.doPublish(testId, { override: true, reason: dto.reason, clientKey: dto.clientKey }, user);
  }

  private async doPublish(testId: string, req: { override: boolean; reason: string | null; clientKey?: string }, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const actor: Actor = { id: user.id, actorRole: user.role };
    const sent: string[] = [];
    const out = await this.prisma.$transaction(async (tx) => {
      const test = await lockTest(tx, testId);
      if (req.clientKey) {
        const again = await tx.testPublication.findUnique({ where: { testId_clientKey: { testId, clientKey: req.clientKey } }, select: PUBLICATION_SELECT });
        if (again) return { replayed: true, published: 0, publication: publicationView(again) };
      }
      const now = await this.deadlines.now(tx);
      const approvedRows = await lockApproved(tx, testId);
      const [byStatus, publications, extensions] = await Promise.all([
        tx.testSubmission.groupBy({ by: ['status'], where: { testId }, _count: { _all: true } }),
        tx.testPublication.count({ where: { testId } }),
        tx.testExtension.groupBy({ by: ['kind'], where: { testId, cancelledAt: null, newDeadline: { gt: now } }, _count: { _all: true } }),
      ]);
      const counts = countsOf(byStatus);
      const decision = decidePublication({
        mayOverride: isAdmin(user), override: req.override, reason: req.reason,
        approved: approvedRows.length, unapproved: counts.unapproved, publications,
      });
      if (decision.kind === 'REPLAY') {
        const latest = await tx.testPublication.findFirstOrThrow({ where: { testId }, orderBy: { number: 'desc' }, select: PUBLICATION_SELECT });
        return { replayed: true, published: 0, publication: publicationView(latest) };
      }
      const running = Object.fromEntries(extensions.map((e) => [e.kind, e._count._all]));
      const snapshot = {
        total: counts.total, byStatus: counts.byStatus, approved: approvedRows.length, alreadyPublished: counts.published,
        unapproved: counts.unapproved, activeExtensions: { test: running.TEST ?? 0, student: running.STUDENT ?? 0, teacher: running.TEACHER ?? 0 },
      };
      const pub = await tx.testPublication.create({
        data: {
          testId, number: publications + 1, publishedById: user.id, actorRole: user.role, override: decision.override,
          overrideReason: decision.reason, publishedCount: approvedRows.length, counts: snapshot, clientKey: req.clientKey ?? null, createdAt: now,
        },
        select: { id: true },
      });
      await publishApproved(tx, approvedRows.map((r) => r.id), pub.id, actor, now, decision.reason);
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'TEST_RESULTS_PUBLISHED', entity: 'Test', entityId: testId,
        metadata: {
          subjectId: test.disciplineId, publicationId: pub.id, number: publications + 1, published: approvedRows.length,
          override: decision.override, reason: decision.reason, counts: snapshot, clientKey: req.clientKey ?? null,
        },
      }, tx);
      if (decision.override) {
        await this.audit.log({
          actorId: user.id, actorRole: user.role, action: 'TEST_PUBLICATION_OVERRIDDEN', entity: 'Test', entityId: testId,
          metadata: { subjectId: test.disciplineId, publicationId: pub.id, reason: decision.reason, unapproved: counts.unapproved, published: approvedRows.length },
        }, tx);
      }
      sent.push(...await this.notifyPublished(tx, test, pub.id, approvedRows.map((r) => r.studentId)));
      const view = await tx.testPublication.findUniqueOrThrow({ where: { id: pub.id }, select: PUBLICATION_SELECT });
      return { replayed: false, published: approvedRows.length, publication: publicationView(view) };
    }, PUBLISH_TX);
    this.notices.dispatchAfterCommit(sent);
    return out;
  }

  /** The students of a publication and their schools' teachers, told once (same transaction, dedupe keys). */
  private async notifyPublished(tx: Tx, test: { id: string; title: string; disciplineId: string }, publicationId: string, studentIds: string[]) {
    const [subject, students, teachers] = await Promise.all([
      tx.discipline.findUniqueOrThrow({ where: { id: test.disciplineId }, select: { name: true } }),
      activeStudents(tx, studentIds),
      schoolTeachersOf(tx, studentIds),
    ]);
    return this.notices.enqueueMany(tx, resultNotices(DecisionEvents.TestResultsPublished, publicationId,
      { id: test.id, title: test.title, subjectName: subject.name }, students, teachers));
  }

  /** Every publication of the test, newest first (who, when, override and reason, counts, how many withdrawn since). */
  async publications(testId: string, q: PublicationsQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total, withdrawals] = await this.prisma.$transaction([
      this.prisma.testPublication.findMany({ where: { testId }, skip, take, orderBy: { number: 'desc' }, select: PUBLICATION_SELECT }),
      this.prisma.testPublication.count({ where: { testId } }),
      this.prisma.testResultWithdrawal.findMany({
        where: { publication: { testId } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100,
        select: {
          id: true, reason: true, actorRole: true, createdAt: true, publicationId: true, withdrawnBy: PERSON,
          submission: { select: { id: true, publicCode: true, status: true, student: { select: { id: true, firstName: true, lastName: true } } } },
        },
      }),
    ]);
    return { ...paginated(rows.map(publicationView), total, page, limit), withdrawals };
  }

  // ── Results with identity (tests.viewResults) ─────────────────────────────────

  /** The final, approved results (published or not): student, school, division, total, status. Paginated, by name. */
  async list(testId: string, q: ListTestResultsQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.TestSubmissionWhereInput = {
      testId, finalMarkingId: { not: null },
      status: q.published === true ? 'PUBLISHED' : q.published === false ? 'APPROVED' : { in: ['APPROVED', 'PUBLISHED'] },
      AND: [
        ...(q.schoolId ? [{ student: { schoolId: q.schoolId } }] : []),
        // The ranking group (owner 2026-11-21): the level at submission, else the student's level now (DIVISION_SQL).
        ...(q.division && q.division !== 'UNKNOWN' ? [{ OR: [{ level: q.division }, { level: null, student: { olympiadLevel: q.division } }] }] : []),
        ...(q.division === 'UNKNOWN' ? [{ level: null, student: { olympiadLevel: null } }] : []),
        ...(contains ? [{ OR: [{ publicCode: contains }, { student: { OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] } }] }] : []),
      ],
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total, test] = await this.prisma.$transaction([
      this.prisma.testSubmission.findMany({
        where, skip, take, orderBy: [{ student: { lastName: 'asc' } }, { student: { firstName: 'asc' } }, { id: 'asc' }],
        select: {
          id: true, publicCode: true, status: true, publishedAt: true, publicationId: true,
          finalMarking: { select: { kind: true, totalMarks: true } },
          student: { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, school: { select: { id: true, name: true } } } },
          _count: { select: { withdrawals: true } },
        },
      }),
      this.prisma.testSubmission.count({ where }),
      this.prisma.test.findUniqueOrThrow({ where: { id: testId }, select: { maxMarks: true } }),
    ]);
    return paginated(rows.map(({ _count, finalMarking, ...r }) => ({
      ...r, totalMarks: finalMarking?.totalMarks ?? null, finalKind: finalMarking?.kind ?? null, maxMarks: test.maxMarks,
      published: r.status === 'PUBLISHED', withdrawals: _count.withdrawals,
    })), total, page, limit);
  }

  // ── Rankings (tests.viewRankings) ─────────────────────────────────────────────

  /** One page of the internal ranking: overall, by division or by school (competition rank; deterministic ties). */
  async rankings(testId: string, q: RankingsQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const by = q.by ?? 'overall';
    const { page, limit, skip, take } = pageArgs(q);
    const test = await this.prisma.test.findUniqueOrThrow({ where: { id: testId }, select: { id: true, title: true, maxMarks: true, discipline: { select: { id: true, code: true, name: true } } } });
    const { rows, total } = await rankingPage(this.prisma, testId, { by, division: q.division, schoolId: q.schoolId, publishedOnly: q.published === true }, skip, take);
    return {
      test, by, method: 'COMPETITION',
      ...paginated(rows.map((r) => ({
        rank: r.rank, groupSize: r.groupSize,
        group: by === 'overall' ? null : by === 'division' ? { division: r.division } : { schoolId: r.schoolId, schoolName: r.schoolName },
        submissionId: r.id, publicCode: r.publicCode, status: r.status, published: r.status === 'PUBLISHED', totalMarks: r.totalMarks,
        student: { id: r.studentId, username: r.username, firstName: r.firstName, lastName: r.lastName, gradeLevel: r.gradeLevel, division: r.division },
        school: r.schoolId ? { id: r.schoolId, name: r.schoolName } : null,
      })), total, page, limit),
    };
  }

  // ── Reports (tests.viewResults) ───────────────────────────────────────────────

  /** The test's results summary: counts, average / median / min / max, distribution, per question, per school, per division. */
  async report(testId: string, q: ResultsReportQueryDto, user: AuthUser) {
    await this.tests.loadInScope(testId, user);
    const publishedOnly = q.published === true;
    const [test, byStatus, results, questions, publications] = await Promise.all([
      this.prisma.test.findUniqueOrThrow({
        where: { id: testId },
        select: { id: true, title: true, status: true, division: true, maxMarks: true, opensAt: true, closesAt: true, discipline: { select: { id: true, code: true, name: true } } },
      }),
      this.prisma.testSubmission.groupBy({ by: ['status'], where: { testId }, _count: { _all: true } }),
      allResults(this.prisma, testId, publishedOnly),
      questionAverages(this.prisma, testId, publishedOnly),
      this.prisma.testPublication.count({ where: { testId } }),
    ]);
    return { test, published: publishedOnly, counts: countsOf(byStatus), publications, ...summarise(results, test.maxMarks), questions };
  }

  /** CSV: one row per result (with marks per question), or the per-school / per-division / per-question summaries. Audited. */
  async exportCsv(testId: string, q: ResultsExportQueryDto, user: AuthUser, res: Response) {
    await this.tests.loadInScope(testId, user);
    const type = q.type ?? 'results';
    const publishedOnly = q.published === true;
    const test = await this.prisma.test.findUniqueOrThrow({ where: { id: testId }, select: { id: true, title: true, maxMarks: true, questions: { orderBy: { order: 'asc' }, select: { id: true, order: true } } } });
    let headers: string[];
    let rows: CsvValue[][];
    if (type === 'results') {
      const results = await allResults(this.prisma, testId, publishedOnly);
      const scores = results.length
        ? await this.prisma.$queryRaw<Array<{ submissionId: string; questionId: string; marks: number | null }>>`
            SELECT s."id" AS "submissionId", sc."questionId", sc."marks" FROM "TestSubmission" s
              JOIN "TestMarkingScore" sc ON sc."markingId" = s."finalMarkingId"
             WHERE s."testId" = ${testId} AND s."status"::text = ANY(${publishedOnly ? ['PUBLISHED'] : ['APPROVED', 'PUBLISHED']}::text[])`
        : [];
      const marks = new Map(scores.map((s) => [`${s.submissionId}:${s.questionId}`, s.marks]));
      let rank = 0;
      headers = ['Rank', 'Submission code', 'Last name', 'First name', 'Username', 'Grade', 'Division', 'School', 'Status',
        ...test.questions.map((x) => `Q${x.order}`), 'Total', 'Maximum', 'Published at'];
      rows = results.map((r, i) => {
        if (i === 0 || results[i - 1].totalMarks !== r.totalMarks) rank = i + 1;
        return [rank, r.publicCode, r.lastName, r.firstName, r.username, r.gradeLevel, r.division, r.schoolName, r.status,
          ...test.questions.map((x) => marks.get(`${r.id}:${x.id}`) ?? null), r.totalMarks, test.maxMarks, r.publishedAt];
      });
    } else if (type === 'questions') {
      const qs = await questionAverages(this.prisma, testId, publishedOnly);
      headers = ['Question', 'Maximum', 'Results', 'Average', 'Minimum', 'Highest'];
      rows = qs.map((x) => [x.order, x.maxMarks, x.results, x.average, x.min, x.max]);
    } else {
      const s = summarise(await allResults(this.prisma, testId, publishedOnly), test.maxMarks);
      if (type === 'schools') {
        headers = ['School', 'Results', 'Average', 'Median', 'Lowest', 'Highest'];
        rows = s.bySchool.map((x) => [x.schoolName ?? '(no school)', x.results, x.average, x.median, x.min, x.max]);
      } else {
        headers = ['Division', 'Results', 'Average', 'Median', 'Lowest', 'Highest'];
        rows = s.byDivision.map((x) => [x.division, x.results, x.average, x.median, x.min, x.max]);
      }
    }
    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'TEST_RESULTS_EXPORTED', entity: 'Test', entityId: testId,
      metadata: { type, published: publishedOnly, rows: rows.length },
    });
    const date = new Date().toISOString().slice(0, 10);
    await sendCsvExport(res, `test-results-${type}-${date}.csv`, csvFromRows(headers, rows));
  }

  /** Every test in the caller's subjects with its counts and averages (the reporting overview). Fixed queries. */
  async overview(q: TestReportsQueryDto, user: AuthUser) {
    const scope = await this.tests.scope(user);
    if (q.subjectId && scope !== 'all' && !scope.includes(q.subjectId)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'SCOPE_FORBIDDEN', 'You do not manage tests in this subject.');
    }
    const where: Prisma.TestWhereInput = {
      ...subjectFilter(scope), status: 'PUBLISHED',
      ...(q.subjectId && { disciplineId: q.subjectId }),
      ...(q.q && { title: { contains: q.q, mode: 'insensitive' } }),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.test.findMany({
        where, skip, take, orderBy: [{ closesAt: 'desc' }, { id: 'asc' }],
        select: { id: true, title: true, division: true, maxMarks: true, opensAt: true, closesAt: true, discipline: { select: { id: true, code: true, name: true } } },
      }),
      this.prisma.test.count({ where }),
    ]);
    const ids = rows.map((r) => r.id);
    const [byStatus, stats, pubs] = ids.length ? await Promise.all([
      this.prisma.testSubmission.groupBy({ by: ['testId', 'status'], where: { testId: { in: ids } }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ testId: string; results: number; average: number | null; min: number | null; max: number | null }>>`
        SELECT s."testId", count(*)::int AS "results", round(avg(m."totalMarks")::numeric, 2)::float8 AS "average",
               min(m."totalMarks")::int AS "min", max(m."totalMarks")::int AS "max"
          FROM "TestSubmission" s JOIN "TestMarking" m ON m."id" = s."finalMarkingId"
         WHERE s."testId" = ANY(${ids}::text[]) AND s."status" IN ('APPROVED', 'PUBLISHED')
         GROUP BY s."testId"`,
      this.prisma.testPublication.groupBy({ by: ['testId'], where: { testId: { in: ids } }, _count: { _all: true }, _max: { createdAt: true } }),
    ]) : [[], [], []];
    return paginated(rows.map((t) => {
      const counts = countsOf(byStatus.filter((b) => b.testId === t.id));
      const st = stats.find((x) => x.testId === t.id);
      const p = pubs.find((x) => x.testId === t.id);
      return {
        ...t, subject: t.discipline, counts,
        results: st?.results ?? 0, average: st?.average ?? null, min: st?.min ?? null, max: st?.max ?? null,
        publications: p?._count._all ?? 0, lastPublishedAt: p?._max.createdAt ?? null,
      };
    }), total, page, limit);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

/** Submissions by status, and the publication view of them: approved (waiting), published, unapproved. */
export function countsOf(byStatus: ReadonlyArray<{ status: string; _count: { _all: number } | true | Record<string, number> }>) {
  const by: Partial<Record<SubmissionStatus, number>> = {};
  for (const b of byStatus) by[b.status as SubmissionStatus] = (by[b.status as SubmissionStatus] ?? 0) + ((b._count as { _all: number })._all ?? 0);
  const total = Object.values(by).reduce((a, n) => a + (n ?? 0), 0);
  const approved = by.APPROVED ?? 0;
  const published = by.PUBLISHED ?? 0;
  return { total, byStatus: by, approved, published, unapproved: total - approved - published };
}

function publicationView(p: Prisma.TestPublicationGetPayload<{ select: typeof PUBLICATION_SELECT }>) {
  const { _count, ...rest } = p;
  return { ...rest, withdrawn: _count.withdrawals };
}

/** Average, median, lowest, highest, the distribution and the per-school / per-division breakdowns of final totals. */
export function summarise(results: readonly ResultRow[], maxMarks: number) {
  const totals = results.map((r) => r.totalMarks);
  const stat = (xs: number[]) => ({
    results: xs.length, average: average(xs), median: median(xs),
    min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null,
  });
  const group = <K extends string | null>(key: (r: ResultRow) => K) => {
    const m = new Map<K, ResultRow[]>();
    for (const r of results) {
      const k = key(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  };
  const bySchool = [...group((r) => r.schoolId)].map(([schoolId, rs]) => ({ schoolId, schoolName: rs[0].schoolName, ...stat(rs.map((r) => r.totalMarks)) }))
    .sort((a, b) => (a.schoolName ?? '￿').localeCompare(b.schoolName ?? '￿') || (a.schoolId ?? '').localeCompare(b.schoolId ?? ''));
  const byDivision = [...group((r) => r.division)].map(([division, rs]) => ({ division, ...stat(rs.map((r) => r.totalMarks)) }))
    .sort((a, b) => a.division.localeCompare(b.division));
  return { summary: { ...stat(totals), maxMarks }, distribution: distributionBands(totals, maxMarks), bySchool, byDivision };
}

