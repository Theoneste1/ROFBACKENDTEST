/**
 * Test Management (WS3, Phase 4) — database steps of publication and withdrawal, and the set-based reads of results and
 * rankings. Every write runs inside the caller's transaction; times are DATABASE time (TestDeadlineService.now).
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { DecisionEvents, type TestResultsPayload } from '../decision-notifications/decision-content.js';
import type { DecisionEvent } from '../decision-notifications/decision-notifications.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { transition } from './marking-rules.js';
import type { Actor } from './marking-store.js';
import { DIVISION_SQL } from './results-rules.js';

type Tx = Prisma.TransactionClient;
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * The APPROVED results of a test, locked FOR UPDATE (an unlock or another decision on one of them waits; one approved
 * meanwhile is simply not part of this publication). Returns their ids and students.
 */
export async function lockApproved(tx: Tx, testId: string): Promise<Array<{ id: string; studentId: string }>> {
  return tx.$queryRaw<Array<{ id: string; studentId: string }>>`
    SELECT "id", "studentId" FROM "TestSubmission" WHERE "testId" = ${testId} AND "status" = 'APPROVED' ORDER BY "id" FOR UPDATE`;
}

/**
 * Publish these locked APPROVED results: APPROVED → PUBLISHED (one row of the transition table, applied to every one in
 * one statement), the publication and its time on each, and one status-history row each — three statements whatever
 * the number. 409 SUBMISSION_CHANGED if any is no longer APPROVED (cannot happen while the caller holds the locks).
 */
export async function publishApproved(
  tx: Tx, ids: readonly string[], publicationId: string, actor: Actor, now: Date, reason: string | null,
): Promise<void> {
  if (ids.length === 0) return;
  const to = transition('PUBLISH', 'APPROVED');
  const list = [...ids];
  const updated = await tx.$executeRaw`
    UPDATE "TestSubmission" SET "status" = ${to}::"TestSubmissionStatus", "publicationId" = ${publicationId}, "publishedAt" = ${now}, "updatedAt" = ${now}
     WHERE "id" = ANY(${list}::text[]) AND "status" = 'APPROVED'`;
  if (updated !== list.length) {
    throw new AppError(HttpStatus.CONFLICT, 'SUBMISSION_CHANGED', 'Some results changed meanwhile; reload and try again.');
  }
  await tx.$executeRaw`
    INSERT INTO "TestSubmissionStatusChange" ("id", "submissionId", "fromStatus", "toStatus", "actorId", "actorRole", "reason", "createdAt")
    SELECT gen_random_uuid()::text, sid, 'APPROVED', ${to}::"TestSubmissionStatus", ${actor.id}, ${actor.actorRole}, ${reason}, ${now}
      FROM unnest(${list}::text[]) AS sid`;
}

export interface Recipient { id: string; email: string; firstName: string; activatedAt: Date | null }

/** ACTIVE student accounts among these (a suspended or archived student is not told). */
export async function activeStudents(db: Db, studentIds: readonly string[]): Promise<Recipient[]> {
  if (studentIds.length === 0) return [];
  return db.$queryRaw<Recipient[]>`
    SELECT "id", "email", "firstName", "activatedAt" FROM "User"
     WHERE "id" = ANY(${[...studentIds]}::text[]) AND "role" = 'STUDENT' AND "accountStatus" = 'ACTIVE'`;
}

/**
 * The teachers who see these students' published results — ACTIVE Teacher accounts with an ACTIVE link to the school of
 * a student whose current claim (PENDING or VERIFIED) is that school, approved, activated and ACTIVE (the same rule as the teacher's views:
 * teacher-scope.ts visibleSchoolStudentsWhere) — with how many of the students each one sees. One query.
 */
export async function schoolTeachersOf(db: Db, studentIds: readonly string[]): Promise<Array<Recipient & { students: number }>> {
  if (studentIds.length === 0) return [];
  return db.$queryRaw<Array<Recipient & { students: number }>>`
    SELECT t."id", t."email", t."firstName", t."activatedAt", count(DISTINCT u."id")::int AS "students"
      FROM "User" u
      JOIN "StudentSchoolAffiliation" f ON f."studentId" = u."id" AND f."schoolId" = u."schoolId" AND f."status" IN ('PENDING', 'VERIFIED') AND f."supersededAt" IS NULL
      JOIN "TeacherSchoolAssignment" ta ON ta."schoolId" = u."schoolId" AND ta."isActive"
      JOIN "User" t ON t."id" = ta."teacherId" AND t."role" = 'TEACHER' AND t."accountStatus" = 'ACTIVE'
     WHERE u."id" = ANY(${[...studentIds]}::text[]) AND u."role" = 'STUDENT' AND u."isApproved" AND u."activatedAt" IS NOT NULL
       AND u."accountStatus" = 'ACTIVE'
     GROUP BY t."id", t."email", t."firstName", t."activatedAt"
     ORDER BY t."id"`;
}

/**
 * The notices of one publication or withdrawal: each student once (their own result), each teacher once (however many of
 * their students) — dedupe keys tie each to this event, so a retry inserts nothing. The payload names the test only.
 */
export function resultNotices(
  type: typeof DecisionEvents.TestResultsPublished | typeof DecisionEvents.TestResultWithdrawn, eventId: string,
  test: { id: string; title: string; subjectName: string }, students: readonly Recipient[], teachers: ReadonlyArray<Recipient & { students: number }>,
): DecisionEvent[] {
  const payload = (r: Recipient, audience: 'STUDENT' | 'TEACHER', count?: number): TestResultsPayload => ({
    activated: r.activatedAt !== null, testId: test.id, testTitle: test.title, subjectName: test.subjectName, audience,
    ...(count !== undefined && { count }),
  });
  return [
    ...students.map((s) => ({
      type, dedupeKey: `${type}:${eventId}:student:${s.id}`,
      recipient: { userId: s.id, email: s.email, firstName: s.firstName },
      entity: { type: 'Test', id: test.id }, payload: payload(s, 'STUDENT'),
    })),
    ...teachers.map((t) => ({
      type, dedupeKey: `${type}:${eventId}:teacher:${t.id}`,
      recipient: { userId: t.id, email: t.email, firstName: t.firstName },
      entity: { type: 'Test', id: test.id }, payload: payload(t, 'TEACHER', t.students),
    })),
  ];
}

// ── Reads ──────────────────────────────────────────────────────────────────────

export interface ResultRow {
  id: string; publicCode: string; status: string; publishedAt: Date | null; totalMarks: number;
  studentId: string; firstName: string; lastName: string; username: string; gradeLevel: string | null;
  schoolId: string | null; schoolName: string | null; division: 'JUNIOR' | 'SENIOR' | 'UNKNOWN';
}

/** The final, approved results of a test (APPROVED and PUBLISHED; or PUBLISHED only), with the student. One query. */
export function resultsBase(testId: string, publishedOnly: boolean): Prisma.Sql {
  const statuses = publishedOnly ? ['PUBLISHED'] : ['APPROVED', 'PUBLISHED'];
  return Prisma.sql`
    SELECT s."id", s."publicCode", s."status"::text AS "status", s."publishedAt", m."totalMarks",
           u."id" AS "studentId", u."firstName", u."lastName", u."username", u."gradeLevel"::text AS "gradeLevel",
           u."schoolId", sc."name" AS "schoolName", ${Prisma.raw(DIVISION_SQL)} AS "division"
      FROM "TestSubmission" s
      JOIN "TestMarking" m ON m."id" = s."finalMarkingId"
      JOIN "User" u ON u."id" = s."studentId"
      LEFT JOIN "School" sc ON sc."id" = u."schoolId"
     WHERE s."testId" = ${testId} AND s."status"::text = ANY(${statuses}::text[])`;
}

/** Every final result of the test (reports: one query, a few thousand small rows at most per test). */
export async function allResults(db: Db, testId: string, publishedOnly: boolean): Promise<ResultRow[]> {
  return db.$queryRaw<ResultRow[]>`${resultsBase(testId, publishedOnly)} ORDER BY m."totalMarks" DESC, u."lastName", u."firstName", s."id"`;
}

/**
 * One page of a ranking: competition rank ("1224": RANK() over the total, descending) within the partition — the whole
 * test, the student's division, or the student's school — listed by partition, rank, last name, first name, id
 * (deterministic). Two queries (the page and its count) whatever the page size.
 */
export async function rankingPage(
  db: Db, testId: string, opts: { by: 'overall' | 'division' | 'school'; division?: string; schoolId?: string; publishedOnly: boolean },
  skip: number, take: number,
): Promise<{ rows: Array<ResultRow & { rank: number; groupSize: number }>; total: number }> {
  // A constant partition (overall) is one group: PARTITION BY takes an expression, never a column position.
  const partition = opts.by === 'overall' ? Prisma.sql`TRUE` : opts.by === 'division' ? Prisma.sql`r."division"` : Prisma.sql`r."schoolId"`;
  const filter = Prisma.sql`WHERE TRUE
    ${opts.division ? Prisma.sql`AND x."division" = ${opts.division}` : Prisma.empty}
    ${opts.schoolId ? Prisma.sql`AND x."schoolId" = ${opts.schoolId}` : Prisma.empty}`;
  const ranked = Prisma.sql`
    WITH r AS (${resultsBase(testId, opts.publishedOnly)}),
         x AS (SELECT r.*, RANK() OVER (PARTITION BY ${partition} ORDER BY r."totalMarks" DESC)::int AS "rank",
                      count(*) OVER (PARTITION BY ${partition})::int AS "groupSize" FROM r)`;
  const [rows, [{ n }]] = await Promise.all([
    db.$queryRaw<Array<ResultRow & { rank: number; groupSize: number }>>`${ranked}
      SELECT x.* FROM x ${filter}
       ORDER BY ${opts.by === 'overall' ? Prisma.empty : opts.by === 'division' ? Prisma.sql`x."division",` : Prisma.sql`x."schoolName" NULLS LAST, x."schoolId" NULLS LAST,`}
                x."rank", x."lastName", x."firstName", x."id"
       LIMIT ${take} OFFSET ${skip}`,
    db.$queryRaw<Array<{ n: number }>>`${ranked} SELECT count(*)::int AS "n" FROM x ${filter}`,
  ]);
  return { rows, total: n };
}

/** Average marks per question over the final results (and how many have marks for it). One query. */
export async function questionAverages(db: Db, testId: string, publishedOnly: boolean) {
  const statuses = publishedOnly ? ['PUBLISHED'] : ['APPROVED', 'PUBLISHED'];
  return db.$queryRaw<Array<{ id: string; order: number; prompt: string; maxMarks: number; results: number; average: number | null; min: number | null; max: number | null }>>`
    SELECT q."id", q."order", q."prompt", q."maxMarks", count(sc."marks")::int AS "results",
           round(avg(sc."marks")::numeric, 2)::float8 AS "average", min(sc."marks")::int AS "min", max(sc."marks")::int AS "max"
      FROM "TestQuestion" q
      LEFT JOIN ("TestMarkingScore" sc JOIN "TestSubmission" s ON s."finalMarkingId" = sc."markingId" AND s."status"::text = ANY(${statuses}::text[]))
        ON sc."questionId" = q."id"
     WHERE q."testId" = ${testId}
     GROUP BY q."id", q."order", q."prompt", q."maxMarks"
     ORDER BY q."order"`;
}
