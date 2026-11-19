/**
 * Test Management (WS3, Phase 3) — database steps shared by the staff (distribution, review) and marker services. Every
 * function runs inside the caller's transaction; times are DATABASE time (TestDeadlineService.now), passed in.
 */
import { HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { AppError } from '../common/errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { markDiff, transition, type MarkingAction, type NormalisedMarks, type SubmissionStatus } from './marking-rules.js';

type Tx = Prisma.TransactionClient;
type Db = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface Actor { id: string; actorRole: string }

export interface LockedSubmission {
  id: string; testId: string; studentId: string; publicCode: string; status: SubmissionStatus;
  currentVersionId: string | null; finalMarkingId: string | null;
}

/** The submission row, locked FOR UPDATE for the rest of the transaction (one decision at a time per submission). */
export async function lockSubmission(tx: Tx, where: { id: string; testId?: string } | { publicCode: string }): Promise<LockedSubmission | null> {
  const rows = 'publicCode' in where
    ? await tx.$queryRaw<LockedSubmission[]>`
        SELECT "id", "testId", "studentId", "publicCode", "status"::text AS "status", "currentVersionId", "finalMarkingId"
          FROM "TestSubmission" WHERE "publicCode" = ${where.publicCode} FOR UPDATE`
    : await tx.$queryRaw<LockedSubmission[]>`
        SELECT "id", "testId", "studentId", "publicCode", "status"::text AS "status", "currentVersionId", "finalMarkingId"
          FROM "TestSubmission" WHERE "id" = ${where.id} FOR UPDATE`;
  const row = rows[0] ?? null;
  if (row && 'id' in where && where.testId && row.testId !== where.testId) return null;
  return row;
}

/**
 * Apply ONE row of the transition table to a locked submission: the new status and its history row (who, role, when,
 * why). Returns the new status. 409 INVALID_STATUS_TRANSITION when the table does not allow it.
 */
export async function changeStatus(
  tx: Tx, sub: LockedSubmission, action: MarkingAction, actor: Actor, now: Date, reason: string | null = null,
  extra: Prisma.TestSubmissionUncheckedUpdateInput = {},
): Promise<SubmissionStatus> {
  const to = transition(action, sub.status);
  await tx.testSubmission.update({ where: { id: sub.id }, data: { status: to, updatedAt: now, ...extra } });
  await tx.testSubmissionStatusChange.create({
    data: { submissionId: sub.id, fromStatus: sub.status, toStatus: to, actorId: actor.id, actorRole: actor.actorRole, reason, createdAt: now },
  });
  sub.status = to;
  return to;
}

/**
 * Store a marking's marks (scores replaced as given, the total and comment), bump its revision, and log every mark that
 * changed in TestMarkChange (who, which question — NULL for the total of a test without questions — old, new, when, why).
 * The database refuses marks above a maximum and any change to a submitted or approved marking (triggers).
 */
export async function writeMarks(
  tx: Tx, markingId: string, hasQuestions: boolean, marks: NormalisedMarks, actor: Actor, now: Date, reason: string | null,
): Promise<number> {
  const current = await tx.testMarking.findUniqueOrThrow({
    where: { id: markingId }, select: { totalMarks: true, scores: { select: { id: true, questionId: true, marks: true } } },
  });
  const before = new Map<string | null, number | null>(
    hasQuestions ? current.scores.filter((s) => s.marks !== null).map((s) => [s.questionId, s.marks]) : [[null, current.totalMarks]],
  );
  const after = new Map<string | null, number | null>(
    hasQuestions ? marks.scores.filter((s) => s.marks !== null).map((s) => [s.questionId, s.marks]) : [[null, marks.totalMarks]],
  );
  const changes = markDiff(before, after);

  if (hasQuestions) {
    const keep = new Set(marks.scores.map((s) => s.questionId));
    const gone = current.scores.filter((s) => !keep.has(s.questionId)).map((s) => s.id);
    if (gone.length) await tx.testMarkingScore.deleteMany({ where: { id: { in: gone } } });
    for (const s of marks.scores) {
      await tx.testMarkingScore.upsert({
        where:  { markingId_questionId: { markingId, questionId: s.questionId } },
        create: { markingId, questionId: s.questionId, marks: s.marks, comment: s.comment, updatedAt: now },
        update: { marks: s.marks, comment: s.comment, updatedAt: now },
      });
    }
  }
  await tx.testMarking.update({
    where: { id: markingId },
    data:  { totalMarks: marks.totalMarks, comment: marks.comment, revision: { increment: 1 }, updatedAt: now },
  });
  if (changes.length) {
    await tx.testMarkChange.createMany({
      data: changes.map((c) => ({
        id: randomUUID(), markingId, questionId: c.questionId, oldMarks: c.oldMarks, newMarks: c.newMarks,
        changedById: actor.id, changedByRole: actor.actorRole, reason, createdAt: now,
      })),
    });
  }
  return changes.length;
}

/** An ACTIVE Coach account with an ACTIVE marker authorisation for the subject, or the reason it is not one. */
export async function coachProblems(tx: Tx, coachIds: readonly string[], disciplineId: string): Promise<Map<string, string>> {
  const rows = await tx.user.findMany({
    where:  { id: { in: [...coachIds] } },
    select: {
      id: true, role: true, accountStatus: true,
      markerAuthorizations: { where: { disciplineId, revokedAt: null }, select: { id: true } },
    },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string>();
  for (const id of coachIds) {
    const c = byId.get(id);
    if (!c || c.role !== 'MENTOR') out.set(id, 'NOT_A_COACH');
    else if (c.accountStatus !== 'ACTIVE') out.set(id, 'ACCOUNT_NOT_ACTIVE');
    else if (c.markerAuthorizations.length === 0) out.set(id, 'NOT_AUTHORIZED');
  }
  return out;
}

/** 400 COACH_NOT_AUTHORIZED (with each coach's problem) unless every coach may mark the subject. */
export async function assertCoachesMayMark(tx: Tx, coachIds: readonly string[], disciplineId: string): Promise<void> {
  const problems = await coachProblems(tx, coachIds, disciplineId);
  if (problems.size) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'COACH_NOT_AUTHORIZED',
      'Only active coaches authorised to mark this subject can be given submissions.',
      { coaches: [...problems].map(([coachId, problem]) => ({ coachId, problem })) });
  }
}

/**
 * G5 for submissions not yet assigned: each SUBMITTED submission of the test with no current FIRST assignment (or only
 * `ids`), with the moment after which nobody can submit or replace it any more — the latest of the test's closesAt and
 * every ACTIVE extension that could still let someone submit for that student: the whole-test extension, the student's
 * own, and that of any teacher who may submit for them (a teacher of one of the student's VERIFIED schools, or one who
 * already submitted a version for them). One query (marking-rules.ts markingEligibleAt is the same rule, unit-tested).
 */
export async function unassignedEligibility(db: Db, testId: string, ids?: readonly string[]): Promise<Array<{ id: string; publicCode: string; eligibleAt: Date }>> {
  const only = ids ? [...ids] : null;
  return db.$queryRaw<Array<{ id: string; publicCode: string; eligibleAt: Date }>>`
    SELECT s."id", s."publicCode", GREATEST(t."closesAt", COALESCE(x."latest", t."closesAt")) AS "eligibleAt"
      FROM "TestSubmission" s
      JOIN "Test" t ON t."id" = s."testId"
      LEFT JOIN LATERAL (
        SELECT max(e."newDeadline") AS "latest" FROM "TestExtension" e
         WHERE e."testId" = s."testId" AND e."cancelledAt" IS NULL AND (
               e."kind" = 'TEST'
            OR (e."kind" = 'STUDENT' AND e."studentId" = s."studentId")
            OR (e."kind" = 'TEACHER' AND (
                  EXISTS (SELECT 1 FROM "TestSubmissionVersion" v WHERE v."submissionId" = s."id" AND v."teacherId" = e."teacherId")
               OR EXISTS (SELECT 1 FROM "TeacherSchoolAssignment" ta
                            JOIN "StudentSchoolAffiliation" f ON f."schoolId" = ta."schoolId"
                           WHERE ta."teacherId" = e."teacherId" AND ta."isActive"
                             AND f."studentId" = s."studentId" AND f."status" = 'VERIFIED' AND f."supersededAt" IS NULL))))
      ) x ON true
     WHERE s."testId" = ${testId} AND s."status" = 'SUBMITTED'
       AND (${only}::text[] IS NULL OR s."id" = ANY(${only}::text[]))
       AND NOT EXISTS (SELECT 1 FROM "TestMarkerAssignment" a WHERE a."submissionId" = s."id" AND a."kind" = 'FIRST' AND a."endedAt" IS NULL)
     ORDER BY s."publicCode"`;
}

/**
 * Create FIRST assignments for many submissions at once (distribution or a manual assignment): the assignment rows, the
 * SUBMITTED → ASSIGNED status (the transition table) and its history rows — three statements whatever the number.
 * 409 SUBMISSION_CHANGED if any submission is no longer SUBMITTED (the caller holds the test row lock, so this means a
 * programming error or a manual change).
 */
export async function assignFirst(
  tx: Tx, pairs: ReadonlyArray<{ submissionId: string; coachId: string }>, method: 'DISTRIBUTION' | 'MANUAL', actor: Actor,
  now: Date, reason: string | null,
): Promise<void> {
  if (pairs.length === 0) return;
  const to = transition('ASSIGN', 'SUBMITTED');
  const sids = pairs.map((p) => p.submissionId);
  const cids = pairs.map((p) => p.coachId);
  const updated = await tx.$executeRaw`
    UPDATE "TestSubmission" SET "status" = ${to}::"TestSubmissionStatus", "updatedAt" = ${now}
     WHERE "id" = ANY(${sids}::text[]) AND "status" = 'SUBMITTED'`;
  if (updated !== pairs.length) {
    throw new AppError(HttpStatus.CONFLICT, 'SUBMISSION_CHANGED', 'Some submissions changed meanwhile; reload and try again.');
  }
  await tx.$executeRaw`
    INSERT INTO "TestMarkerAssignment" ("id", "submissionId", "kind", "coachId", "assignedById", "assignedAt", "method", "reason")
    SELECT gen_random_uuid()::text, x.sid, 'FIRST', x.cid, ${actor.id}, ${now}, ${method}, ${reason}
      FROM unnest(${sids}::text[], ${cids}::text[]) AS x(sid, cid)`;
  await tx.$executeRaw`
    INSERT INTO "TestSubmissionStatusChange" ("id", "submissionId", "fromStatus", "toStatus", "actorId", "actorRole", "reason", "createdAt")
    SELECT gen_random_uuid()::text, sid, 'SUBMITTED', ${to}::"TestSubmissionStatus", ${actor.id}, ${actor.actorRole}, ${reason}, ${now}
      FROM unnest(${sids}::text[]) AS sid`;
}
