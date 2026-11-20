/**
 * Test Management (WS3, Phase 3) — the pure rules of marking, shared by the services and unit-tested on their own:
 * the fixed status transition table, when a submission may be marked (G5), even distribution, mark limits (G7), the
 * mark-change diff and the blind field list.
 *
 * Status flow (owner spec): SUBMITTED → ASSIGNED → MARKING_IN_PROGRESS → MARKED (awaiting approval) → APPROVED, plus
 * RETURNED (for correction) and AWAITING_SECOND_MARKING. PUBLISHED is reserved for Phase 4 (publication): no Phase 3
 * action reaches it or leaves it. Every change goes through `transition` — one row of TRANSITIONS — and is recorded in
 * TestSubmissionStatusChange; there is no other way to change a status, so no step can be skipped through the API.
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import type { ExtensionLike } from './submission-rules.js';

export type SubmissionStatus =
  'SUBMITTED' | 'ASSIGNED' | 'MARKING_IN_PROGRESS' | 'MARKED' | 'APPROVED' | 'PUBLISHED' | 'RETURNED' | 'AWAITING_SECOND_MARKING';

export const SUBMISSION_STATUSES: readonly SubmissionStatus[] = [
  'SUBMITTED', 'ASSIGNED', 'MARKING_IN_PROGRESS', 'MARKED', 'APPROVED', 'PUBLISHED', 'RETURNED', 'AWAITING_SECOND_MARKING',
];

export type MarkingAction =
  | 'ASSIGN'                  // distribution or manual assignment of the FIRST marking
  | 'REASSIGN_FIRST'          // another coach takes over the FIRST marking (reason)
  | 'REASSIGN_SECOND'         // another coach takes over the SECOND marking (reason)
  | 'START_MARKING'           // the marker's first save (or the first save after a return)
  | 'SUBMIT_MARKING'          // the marker submits for approval
  | 'APPROVE'                 // reviewer: approve (locks)
  | 'RETURN'                  // reviewer: return a marking for correction (comment)
  | 'REQUEST_SECOND_MARKING'  // reviewer: an independent, blind second marking by another authorised coach
  | 'CHOOSE_MARK'             // subject Head Coach: first, second or adjusted mark (reason); the status stays MARKED
  | 'UNLOCK';                 // reviewer: unlock an approved result (reason)

/** The ONLY allowed status changes, by action. */
export const TRANSITIONS: Readonly<Record<MarkingAction, ReadonlyArray<readonly [SubmissionStatus, SubmissionStatus]>>> = {
  ASSIGN:                 [['SUBMITTED', 'ASSIGNED']],
  REASSIGN_FIRST:         [['ASSIGNED', 'ASSIGNED'], ['MARKING_IN_PROGRESS', 'ASSIGNED'], ['RETURNED', 'ASSIGNED']],
  REASSIGN_SECOND:        [['AWAITING_SECOND_MARKING', 'AWAITING_SECOND_MARKING'], ['MARKING_IN_PROGRESS', 'AWAITING_SECOND_MARKING'], ['RETURNED', 'AWAITING_SECOND_MARKING']],
  START_MARKING:          [['ASSIGNED', 'MARKING_IN_PROGRESS'], ['RETURNED', 'MARKING_IN_PROGRESS']],
  SUBMIT_MARKING:         [['MARKING_IN_PROGRESS', 'MARKED'], ['AWAITING_SECOND_MARKING', 'MARKED']],
  APPROVE:                [['MARKED', 'APPROVED']],
  RETURN:                 [['MARKED', 'RETURNED']],
  REQUEST_SECOND_MARKING: [['MARKED', 'AWAITING_SECOND_MARKING']],
  CHOOSE_MARK:            [['MARKED', 'MARKED']],
  UNLOCK:                 [['APPROVED', 'MARKED']],
};

/** Every allowed (from → to) pair, whatever the action ("SUBMITTED>ASSIGNED"). */
export const ALLOWED_PAIRS: ReadonlySet<string> = new Set(
  Object.values(TRANSITIONS).flatMap((rows) => rows.map(([from, to]) => `${from}>${to}`)),
);

/** The status an action leads to from `from`, or null when the table does not allow it. */
export function nextStatus(action: MarkingAction, from: SubmissionStatus): SubmissionStatus | null {
  return TRANSITIONS[action].find(([f]) => f === from)?.[1] ?? null;
}

/** 409 INVALID_STATUS_TRANSITION unless the table allows `action` from `from` (a concurrent decision lands here too). */
export function transition(action: MarkingAction, from: SubmissionStatus): SubmissionStatus {
  const to = nextStatus(action, from);
  if (to === null) {
    throw new AppError(HttpStatus.CONFLICT, 'INVALID_STATUS_TRANSITION',
      `This cannot be done while the submission is ${STATUS_TEXT[from]}.`,
      { action, status: from, allowedFrom: TRANSITIONS[action].map(([f]) => f) });
  }
  return to;
}

export const STATUS_TEXT: Readonly<Record<SubmissionStatus, string>> = {
  SUBMITTED: 'submitted (not assigned)',
  ASSIGNED: 'assigned to a marker',
  MARKING_IN_PROGRESS: 'being marked',
  MARKED: 'marked (awaiting approval)',
  APPROVED: 'approved',
  PUBLISHED: 'published',
  RETURNED: 'returned for correction',
  AWAITING_SECOND_MARKING: 'awaiting second marking',
};

// ── G5: when marking may begin ─────────────────────────────────────────────────

/**
 * The moment after which nobody can submit or replace this student's answer any more: the latest of the test's closesAt
 * and every ACTIVE extension that could still let someone submit for the student — the whole-test extension, the
 * student's own, and the extension of any teacher who may submit for them (a teacher of one of the student's verified
 * schools, or one who already submitted a version for them). Marking may begin only strictly AFTER it (a submission at
 * the deadline instant is still on time).
 */
export function markingEligibleAt(
  closesAt: Date, extensions: readonly ExtensionLike[], studentId: string, relevantTeacherIds: ReadonlySet<string>,
): Date {
  let latest = closesAt;
  for (const e of extensions) {
    if (e.cancelledAt !== null) continue;
    const applies = e.kind === 'TEST'
      || (e.kind === 'STUDENT' && e.studentId === studentId)
      || (e.kind === 'TEACHER' && e.teacherId !== null && relevantTeacherIds.has(e.teacherId));
    if (applies && e.newDeadline.getTime() > latest.getTime()) latest = e.newDeadline;
  }
  return latest;
}

/** Marking may begin (G5): strictly after the latest applicable deadline, by DATABASE time. */
export function markingEligible(now: Date, eligibleAt: Date): boolean {
  return now.getTime() > eligibleAt.getTime();
}

// ── Even distribution ──────────────────────────────────────────────────────────

/**
 * Give each submission to the coach with the fewest current assignments on this test (existing ones included), ties to
 * the coach listed first; the result is as even as possible: every coach ends within one of every other (when they all
 * start equal), and a coach already ahead receives fewer. Deterministic for the same input.
 */
export function distributeEvenly(
  submissionIds: readonly string[], coaches: ReadonlyArray<{ id: string; load: number }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>(coaches.map((c) => [c.id, []]));
  if (coaches.length === 0) return out;
  const load = coaches.map((c) => c.load);
  for (const s of submissionIds) {
    let best = 0;
    for (let i = 1; i < load.length; i++) if (load[i] < load[best]) best = i;
    out.get(coaches[best].id)!.push(s);
    load[best]++;
  }
  return out;
}

// ── Marks (G7: whole numbers, never above the maxima) ─────────────────────────

export interface QuestionMax { id: string; order: number; maxMarks: number }
export interface ScoreInput { questionId: string; marks?: number | null; comment?: string | null }
export interface MarksInput { scores?: readonly ScoreInput[]; totalMarks?: number | null; comment?: string | null }
export interface NormalisedMarks {
  /** Per question (questions that have marks or a comment), in question order. */
  scores: Array<{ questionId: string; marks: number | null; comment: string | null }>;
  /** Questions: the sum of the marks entered so far (null while none); one total: the total entered. */
  totalMarks: number | null;
  comment: string | null;
  /** Every question has marks (or, without questions, the total is entered). */
  complete: boolean;
}

const bad = (code: string, message: string, details?: Record<string, unknown>) => new AppError(HttpStatus.BAD_REQUEST, code, message, details);
const isWhole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);
const clean = (t: string | null | undefined) => (t === undefined || t === null || t.trim() === '' ? null : t.trim());

/**
 * The marks of a marking, checked against the test: per question when it has questions (no separate total), else one
 * total. Whole, non-negative marks, never above a question's or the test's maximum. 400 MARKS_NOT_WHOLE,
 * MARKS_EXCEED_MAXIMUM, QUESTION_NOT_IN_TEST, DUPLICATE_QUESTION, TOTAL_NOT_ALLOWED (questions), SCORES_NOT_ALLOWED (no
 * questions). `forSubmit`: every question (or the total) must be marked — 400 MARKS_INCOMPLETE with the missing ones.
 */
export function normaliseMarks(questions: readonly QuestionMax[], testMax: number, input: MarksInput, forSubmit: boolean): NormalisedMarks {
  const comment = clean(input.comment);
  if (questions.length === 0) {
    if (input.scores && input.scores.length > 0) {
      throw bad('SCORES_NOT_ALLOWED', 'This test has no questions: give one total.');
    }
    const total = input.totalMarks ?? null;
    if (total !== null) {
      if (!isWhole(total) || total < 0) throw bad('MARKS_NOT_WHOLE', 'Marks are whole numbers, 0 or more.', { totalMarks: total });
      if (total > testMax) throw bad('MARKS_EXCEED_MAXIMUM', `At most ${testMax} marks.`, { max: testMax, totalMarks: total });
    }
    if (forSubmit && total === null) throw bad('MARKS_INCOMPLETE', 'Give the total marks.', { missing: ['total'] });
    return { scores: [], totalMarks: total, comment, complete: total !== null };
  }
  if (input.totalMarks !== undefined && input.totalMarks !== null) {
    throw bad('TOTAL_NOT_ALLOWED', 'This test has questions: the total is the sum of the question marks.');
  }
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  const given = new Map<string, { marks: number | null; comment: string | null }>();
  for (const s of input.scores ?? []) {
    const q = byId.get(s.questionId);
    if (!q) throw bad('QUESTION_NOT_IN_TEST', 'A question of another test.', { questionId: s.questionId });
    if (seen.has(s.questionId)) throw bad('DUPLICATE_QUESTION', 'Each question once.', { questionId: s.questionId, order: q.order });
    seen.add(s.questionId);
    const marks = s.marks ?? null;
    if (marks !== null) {
      if (!isWhole(marks) || marks < 0) throw bad('MARKS_NOT_WHOLE', 'Marks are whole numbers, 0 or more.', { question: q.order, marks });
      if (marks > q.maxMarks) throw bad('MARKS_EXCEED_MAXIMUM', `Question ${q.order}: at most ${q.maxMarks} marks.`, { question: q.order, max: q.maxMarks, marks });
    }
    const c = clean(s.comment);
    if (marks !== null || c !== null) given.set(q.id, { marks, comment: c });
  }
  const ordered = [...questions].sort((a, b) => a.order - b.order);
  const missing = ordered.filter((q) => given.get(q.id)?.marks == null).map((q) => q.order);
  if (forSubmit && missing.length) throw bad('MARKS_INCOMPLETE', 'Give marks for every question.', { missing });
  const scores = ordered.filter((q) => given.has(q.id)).map((q) => ({ questionId: q.id, ...given.get(q.id)! }));
  const marked = scores.filter((s) => s.marks !== null);
  const totalMarks = marked.length ? marked.reduce((a, s) => a + s.marks!, 0) : null;
  return { scores, totalMarks, comment, complete: missing.length === 0 };
}

/**
 * What changed between two states of a marking's marks (question → marks; the key null is the total of a test without
 * questions): one entry per question whose marks differ (old or new may be null: not given).
 */
export function markDiff(
  before: ReadonlyMap<string | null, number | null>, after: ReadonlyMap<string | null, number | null>,
): Array<{ questionId: string | null; oldMarks: number | null; newMarks: number | null }> {
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  return keys
    .map((k) => ({ questionId: k, oldMarks: before.get(k) ?? null, newMarks: after.get(k) ?? null }))
    .filter((c) => c.oldMarks !== c.newMarks);
}

// ── Marker queue ───────────────────────────────────────────────────────────────

export type QueueState = 'NOT_STARTED' | 'IN_PROGRESS' | 'MARKED';

/** The marker's view of one assignment: nothing saved yet, a draft (or a returned marking), or submitted / approved. */
export function queueState(markingStatus: 'DRAFT' | 'SUBMITTED' | 'RETURNED' | 'APPROVED' | null | undefined): QueueState {
  if (!markingStatus) return 'NOT_STARTED';
  return markingStatus === 'DRAFT' || markingStatus === 'RETURNED' ? 'IN_PROGRESS' : 'MARKED';
}

// ── Blind marking ──────────────────────────────────────────────────────────────

/**
 * Fields a marker's response must NEVER contain (any depth): who the student is (names, username, contacts, school,
 * grade, division), who submitted and when (role, teacher, timestamps that would reveal a late submission under an
 * extension), extensions, other markers and their marks. Marker responses are built from an explicit whitelist
 * (test-marker.service.ts); this list is the backstop the tests (and assertBlind) check against.
 */
export const MARKER_FORBIDDEN_FIELDS: readonly string[] = [
  'student', 'studentId', 'firstName', 'lastName', 'username', 'email', 'phone', 'phoneNumber', 'dateOfBirth',
  'school', 'schoolId', 'schoolName', 'gradeLevel', 'division', 'divisionId',
  'submittedBy', 'submittedById', 'submitterRole', 'teacher', 'teacherId', 'submittedAt', 'firstSubmittedAt', 'lastSubmittedAt',
  'versionCount', 'applicableDeadline', 'deadline', 'underExtension', 'extended', 'extension', 'extensionId', 'extensionKind',
  'marker', 'markerId', 'firstMarking', 'secondMarking', 'markings', 'storageKey', 'originalName',
];

/** Throws when a marker response holds a forbidden field at any depth (a programming error: 500, never sent). */
export function assertBlind(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertBlind(v, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object' || value instanceof Date) return;
  for (const [k, v] of Object.entries(value)) {
    if (MARKER_FORBIDDEN_FIELDS.includes(k)) throw new Error(`Blind marking: "${path}.${k}" must not be sent to a marker.`);
    assertBlind(v, `${path}.${k}`);
  }
}
