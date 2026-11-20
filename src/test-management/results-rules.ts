/**
 * Test Management (WS3, Phase 4) — the pure rules of publication, results and rankings, shared by the services and
 * unit-tested on their own.
 *
 * Publication (owner spec 10.1)
 *   Only APPROVED results are published (APPROVED → PUBLISHED, the transition table); every other result stays hidden.
 *   While any result is not approved, a subject Head Coach is BLOCKED; an Administrator may OVERRIDE with a mandatory
 *   reason (audited) — and the override still publishes the approved results only. A Head Coach can never override
 *   (403, whatever the request says). Nothing left to publish and nothing unapproved: the latest publication is returned
 *   (a repeated or concurrent request publishes nothing twice and notifies nobody twice).
 *
 * Rankings (owner spec 10.3): internal only (Administrators; Head Coaches of the subject). Competition ranking ("1224"):
 * equal totals share a rank and the next rank skips the tied places; within a tie rows are listed by last name, first
 * name, then id (deterministic). Partitions: overall, by division (Junior S1–S3 / Senior S4–S6, from the student's grade),
 * by school (the student's school). Students and Teachers never receive a rank: STUDENT_RANKINGS_ENABLED is false and
 * Test.studentRankingsVisible is refused by a CHECK (design only).
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import type { SubmissionStatus } from './marking-rules.js';
import { divisionOfGrade } from './submission-rules.js';

/**
 * DESIGN ONLY (owner spec 10.3): the future configurable option to show rankings to students. Off in this release: no
 * route reads it as true, the student view never carries a rank (assertNoRankings), and the database refuses
 * Test.studentRankingsVisible = true (CHECK Test_student_rankings_design_only). Turning it on later is a reviewed change:
 * a migration dropping that CHECK, this constant, and a rank field added to the student result view.
 */
export const STUDENT_RANKINGS_ENABLED = false as const;

/** Whether a student may see rankings for this test: never in this release, whatever the test row says. */
export function studentRankingsVisible(test: { studentRankingsVisible: boolean }): boolean {
  return STUDENT_RANKINGS_ENABLED && test.studentRankingsVisible;
}

// ── Publication ──────────────────────────────────────────────────────────────

/** Not yet approved: everything before APPROVED (PUBLISHED results are approved and already out). */
export const UNAPPROVED_STATUSES: readonly SubmissionStatus[] = [
  'SUBMITTED', 'ASSIGNED', 'MARKING_IN_PROGRESS', 'MARKED', 'RETURNED', 'AWAITING_SECOND_MARKING',
];

export const isUnapproved = (s: string) => (UNAPPROVED_STATUSES as readonly string[]).includes(s);

export interface PublicationRequest {
  /** The caller may override (Administrator / Super Admin); a Head Coach never may. */
  mayOverride: boolean;
  override: boolean;
  reason: string | null | undefined;
  /** Results APPROVED and not yet published. */
  approved: number;
  /** Results not yet approved (UNAPPROVED_STATUSES). */
  unapproved: number;
  /** Publications of this test so far. */
  publications: number;
}

export type PublicationDecision =
  | { kind: 'PUBLISH'; override: boolean; reason: string | null }
  /** Nothing new to publish and nothing blocking: the latest publication stands (a retry or a concurrent request). */
  | { kind: 'REPLAY' };

const clean = (t: string | null | undefined) => (t === undefined || t === null || t.trim() === '' ? null : t.trim());

/**
 * What a publish request does — or why it is refused:
 *   403 OVERRIDE_NOT_ALLOWED       an override by anyone but an Administrator (a Head Coach can never override);
 *   400 OVERRIDE_REASON_REQUIRED   an override without a reason (at least 10 characters);
 *   409 PUBLICATION_BLOCKED        results not approved yet and no override (the preview lists them);
 *   409 NOTHING_TO_PUBLISH         no approved result to publish (and the test was never published, or unapproved remain).
 * An override when everything is approved overrides nothing: it is an ordinary publication (override false, no reason).
 */
export function decidePublication(r: PublicationRequest): PublicationDecision {
  if (r.override && !r.mayOverride) {
    throw new AppError(HttpStatus.FORBIDDEN, 'OVERRIDE_NOT_ALLOWED', 'Only an Administrator can override the publication checks.');
  }
  const reason = clean(r.reason);
  if (r.override && (reason === null || reason.length < MIN_OVERRIDE_REASON)) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'OVERRIDE_REASON_REQUIRED',
      `An override needs a reason (at least ${MIN_OVERRIDE_REASON} characters).`);
  }
  if (r.approved === 0) {
    if (r.unapproved === 0 && r.publications > 0) return { kind: 'REPLAY' };
    throw new AppError(HttpStatus.CONFLICT, 'NOTHING_TO_PUBLISH', 'No approved result is waiting to be published.',
      { unapproved: r.unapproved });
  }
  if (r.unapproved > 0 && !r.override) {
    throw new AppError(HttpStatus.CONFLICT, 'PUBLICATION_BLOCKED',
      r.mayOverride
        ? 'Some results are not approved yet. Approve them first, or override with a reason (only the approved results are published).'
        : 'Some results are not approved yet. Approve them first; only an Administrator can override.',
      { unapproved: r.unapproved, approved: r.approved, overrideAvailable: r.mayOverride });
  }
  return r.unapproved > 0 ? { kind: 'PUBLISH', override: true, reason } : { kind: 'PUBLISH', override: false, reason: null };
}

export const MIN_OVERRIDE_REASON = 10;

// ── Results ──────────────────────────────────────────────────────────────────

/** Whole percentage bands of a results distribution: 0–9 %, 10–19 % … 90–100 % (the maximum falls in the last). */
export function distributionBands(totals: readonly number[], maxMarks: number): Array<{ from: number; to: number; count: number }> {
  const bands = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i === 9 ? 100 : i * 10 + 9, count: 0 }));
  if (maxMarks <= 0) return bands;
  for (const t of totals) bands[Math.min(9, Math.floor((t / maxMarks) * 10))].count++;
  return bands;
}

/** Average to two decimals (null without values). */
export function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
}

/** Median (null without values). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface RankInput { id: string; total: number; lastName: string; firstName: string; group?: string | null }

/**
 * Competition ranking ("1224") within each group (overall: one group): ordered by total descending, ties by last name,
 * first name, id. The SQL of the rankings endpoint (RANK() OVER …, same ORDER BY) is the same rule; this function is the
 * reference the unit tests pin down.
 */
export function competitionRank<T extends RankInput>(rows: readonly T[]): Array<T & { rank: number }> {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const g = r.group ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(r);
  }
  const out: Array<T & { rank: number }> = [];
  for (const [, list] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sorted = [...list].sort((a, b) => b.total - a.total || cmp(a.lastName, b.lastName) || cmp(a.firstName, b.firstName) || cmp(a.id, b.id));
    sorted.forEach((r, i) => {
      const rank = i > 0 && sorted[i - 1].total === r.total ? out[out.length - 1].rank : i + 1;
      out.push({ ...r, rank });
    });
  }
  return out;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ── What students and teachers may receive ───────────────────────────────────

/**
 * Fields a student's or teacher's result response must NEVER contain (any depth): rankings and positions, who marked
 * (marker identity, the marking kinds, reviewers), the internal workflow (assignments, reviews, mark changes, other
 * markings), and storage details. Built from a whitelist (test-results.service.ts); this list is the backstop.
 */
export const RESULT_FORBIDDEN_FIELDS: readonly string[] = [
  'rank', 'ranking', 'rankings', 'position', 'percentile',
  'marker', 'markerId', 'markers', 'firstMarker', 'secondMarker', 'coach', 'coachId', 'reviewer', 'actor', 'actorId',
  'kind', 'markings', 'firstMarking', 'secondMarking', 'assignments', 'reviews', 'markChanges', 'statusHistory',
  'storageKey', 'publicCode',
];

/** Throws when a student / teacher result response holds a forbidden field at any depth (a programming error: 500). */
export function assertResultSafe(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertResultSafe(v, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
  for (const [k, v] of Object.entries(value)) {
    if (RESULT_FORBIDDEN_FIELDS.includes(k)) throw new Error(`Results: "${path}.${k}" must not be sent to a student or teacher.`);
    assertResultSafe(v, `${path}.${k}`);
  }
}

export interface QuestionOfTest { id: string; order: number; prompt: string; maxMarks: number }
export interface FinalScore { questionId: string; marks: number | null; comment: string | null }

/**
 * One published result as its student (or a teacher of their school) sees it: per question (where the test has
 * questions) the marks and the comment of the FINAL marking only, the total, the overall comment. Never who marked, never
 * a rank, never another marking.
 */
export function resultView(
  questions: readonly QuestionOfTest[], maxMarks: number, final: { totalMarks: number | null; comment: string | null; scores: readonly FinalScore[] },
) {
  const byQ = new Map(final.scores.map((s) => [s.questionId, s]));
  return {
    totalMarks: final.totalMarks,
    maxMarks,
    comment: final.comment,
    questions: [...questions].sort((a, b) => a.order - b.order).map((q) => ({
      order: q.order, prompt: q.prompt, maxMarks: q.maxMarks,
      marks: byQ.get(q.id)?.marks ?? null, comment: byQ.get(q.id)?.comment ?? null,
    })),
  };
}

/** The division a grade belongs to for rankings and reports: S1–S3 Junior, S4–S6 Senior, anything else unknown. */
export function rankingDivision(gradeLevel: string | null | undefined): 'JUNIOR' | 'SENIOR' | 'UNKNOWN' {
  return divisionOfGrade(gradeLevel) ?? 'UNKNOWN';
}

/** The same rule in SQL (rankings and reports), for a "User" row aliased `u`. */
export const DIVISION_SQL = `CASE WHEN u."gradeLevel" IN ('S1', 'S2', 'S3') THEN 'JUNIOR' WHEN u."gradeLevel" IN ('S4', 'S5', 'S6') THEN 'SENIOR' ELSE 'UNKNOWN' END`;
