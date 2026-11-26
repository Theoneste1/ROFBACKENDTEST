/**
 * Question-level marking (design Rev 5.2, approved 2026-11-26) — the pure rules, unit-tested on their own and mirrored by
 * the database (migration 20270101000100_question_marking: test_question_task_guard, question_paper_status_of):
 *   - a task is one student's answer to one question in one round (FIRST, or SECOND cycle n); only its holder marks it;
 *   - the fixed transition table (§4) — the trigger checks the same (round, from, to) triples;
 *   - the paper's status is a projection of its FIRST-round tasks (§4) — projectPaper here, question_paper_status_of in SQL;
 *   - the refusal codes the API returns, in plain words with what to do next.
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';

export type TaskRound = 'FIRST' | 'SECOND';
export type TaskStatus =
  | 'NOT_STARTED' | 'IN_PROGRESS' | 'SUBMITTED' | 'UNDER_REVIEW' | 'RETURNED' | 'AWAITING_SECOND' | 'APPROVED' | 'CLOSED' | 'CANCELLED';
export type PaperStatus = 'SUBMITTED' | 'MARKING_IN_PROGRESS' | 'MARKED' | 'RETURNED' | 'APPROVED';

export const FIRST_STATUSES: readonly TaskStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW', 'RETURNED', 'AWAITING_SECOND', 'APPROVED'];
export const SECOND_STATUSES: readonly TaskStatus[] = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'RETURNED', 'CLOSED', 'CANCELLED'];

/** Every allowed status change, as "ROUND:FROM>TO" (same list as the database trigger). */
export const TASK_TRANSITIONS: ReadonlySet<string> = new Set([
  'FIRST:NOT_STARTED>IN_PROGRESS', 'FIRST:IN_PROGRESS>NOT_STARTED', 'FIRST:IN_PROGRESS>SUBMITTED', 'FIRST:IN_PROGRESS>RETURNED',
  'FIRST:RETURNED>IN_PROGRESS', 'FIRST:SUBMITTED>UNDER_REVIEW', 'FIRST:UNDER_REVIEW>SUBMITTED',
  'FIRST:SUBMITTED>APPROVED', 'FIRST:UNDER_REVIEW>APPROVED', 'FIRST:SUBMITTED>RETURNED', 'FIRST:UNDER_REVIEW>RETURNED',
  'FIRST:SUBMITTED>AWAITING_SECOND', 'FIRST:UNDER_REVIEW>AWAITING_SECOND', 'FIRST:AWAITING_SECOND>APPROVED',
  'FIRST:AWAITING_SECOND>SUBMITTED', 'FIRST:APPROVED>RETURNED', 'FIRST:APPROVED>SUBMITTED',
  'SECOND:NOT_STARTED>IN_PROGRESS', 'SECOND:IN_PROGRESS>NOT_STARTED', 'SECOND:IN_PROGRESS>SUBMITTED', 'SECOND:IN_PROGRESS>RETURNED',
  'SECOND:RETURNED>IN_PROGRESS', 'SECOND:SUBMITTED>RETURNED', 'SECOND:SUBMITTED>CLOSED',
  'SECOND:NOT_STARTED>CANCELLED', 'SECOND:IN_PROGRESS>CANCELLED', 'SECOND:RETURNED>CANCELLED',
]);

export function transitionAllowed(round: TaskRound, from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_TRANSITIONS.has(`${round}:${from}>${to}`);
}

const REVIEWED: ReadonlySet<TaskStatus> = new Set(['SUBMITTED', 'UNDER_REVIEW', 'AWAITING_SECOND', 'APPROVED']);

/**
 * The paper status from its FIRST-round task statuses (§4), first rule that matches:
 * any RETURNED → RETURNED; all APPROVED → APPROVED; all submitted or beyond → MARKED; any started → MARKING_IN_PROGRESS;
 * otherwise (or no task yet) SUBMITTED. A PUBLISHED paper stays PUBLISHED while this says APPROVED.
 */
export function projectPaper(statuses: readonly TaskStatus[]): PaperStatus {
  if (statuses.length === 0) return 'SUBMITTED';
  if (statuses.includes('RETURNED')) return 'RETURNED';
  if (statuses.every((s) => s === 'APPROVED')) return 'APPROVED';
  if (statuses.every((s) => REVIEWED.has(s))) return 'MARKED';
  if (statuses.some((s) => s !== 'NOT_STARTED')) return 'MARKING_IN_PROGRESS';
  return 'SUBMITTED';
}

/** What a paper "shows" in the overviews (finer than the stored status). */
export function paperProgress(statuses: readonly TaskStatus[]): 'NOT_STARTED' | 'PARTIALLY_MARKED' | 'ALL_SUBMITTED' | 'PARTIALLY_APPROVED' | 'RETURNED_WORK' | 'FULLY_APPROVED' {
  const p = projectPaper(statuses);
  if (p === 'RETURNED') return 'RETURNED_WORK';
  if (p === 'APPROVED') return 'FULLY_APPROVED';
  if (p === 'MARKED') return statuses.some((s) => s === 'APPROVED') ? 'PARTIALLY_APPROVED' : 'ALL_SUBMITTED';
  if (p === 'MARKING_IN_PROGRESS') return 'PARTIALLY_MARKED';
  return 'NOT_STARTED';
}

/** The coach queue's views (the saved "Show" choice applies the same three plus the question-only ones). */
export const COACH_VIEWS = ['TO_MARK', 'MINE', 'RETURNED', 'SUBMITTED', 'ALL'] as const;
export type CoachView = (typeof COACH_VIEWS)[number];

/** Lock settings (SystemSetting overrides; defaults from the design). */
export const DEFAULT_MAX_ACTIVE_CLAIMS = 3;
export const DEFAULT_LOCK_MINUTES = 30;
export const REVIEW_HOLD_MINUTES = 15;
export const HEARTBEAT_SECONDS = 120;
export const MAX_CLAIM_ATTEMPTS = 3;
export const SETTING_MAX_ACTIVE_CLAIMS = 'marking.maxActiveClaims';
export const SETTING_LOCK_MINUTES = 'marking.lockMinutes';

/** The public reference of a task: the paper code and the question's number, never the student. */
export function taskRef(code: string, order: number, round: TaskRound, cycle: number): string {
  return round === 'FIRST' ? `${code}/q${order}` : `${code}/q${order}/second-${cycle}`;
}

// ── Refusals (plain words + what to do next) ─────────────────────────────────────────────────────────────────────────

export type LostReason = 'EXPIRED' | 'REASSIGNED' | 'RELEASED_BY_STAFF' | 'AUTHORISATION_LOST' | 'RELEASED' | 'SUBMITTED' | 'CANCELLED';

export const qmErrors = {
  wrongMode: (mode: string) => new AppError(HttpStatus.CONFLICT, 'WRONG_MARKING_MODE',
    mode === 'QUESTION'
      ? 'This test is marked question by question. Use the question marking screens for it.'
      : 'This test is marked paper by paper. Switch it to question marking first (only possible before marking starts).',
    { markingMode: mode }),
  taskNotFound: () => new AppError(HttpStatus.NOT_FOUND, 'TASK_NOT_FOUND', 'This question task does not exist. Go back to the list and choose another.'),
  taskTaken: () => new AppError(HttpStatus.CONFLICT, 'TASK_TAKEN', 'Another coach started this question a moment ago. Choose another paper.'),
  taskNotAvailable: (why: string) => new AppError(HttpStatus.CONFLICT, 'TASK_NOT_AVAILABLE',
    'This question cannot be marked now. Go back to the list to see what is available.', { why }),
  questionNotAssigned: () => new AppError(HttpStatus.FORBIDDEN, 'QUESTION_NOT_ASSIGNED',
    'You are not one of the coaches for this question. Ask the Head Coach if you should be.'),
  markerNotAuthorized: () => new AppError(HttpStatus.FORBIDDEN, 'MARKER_NOT_AUTHORIZED',
    'You can no longer mark this subject: your authorisation was removed. Ask the Head Coach if this is unexpected.'),
  firstMarkerExcluded: () => new AppError(HttpStatus.FORBIDDEN, 'FIRST_MARKER_EXCLUDED',
    'You marked this answer already, so the second assessment must be done by another coach.'),
  claimLimit: (limit: number) => new AppError(HttpStatus.CONFLICT, 'CLAIM_LIMIT',
    `You already hold ${limit} questions. Submit or give one back before taking another.`, { limit }),
  claimLimitFor: (limit: number) => new AppError(HttpStatus.CONFLICT, 'CLAIM_LIMIT',
    `This coach already holds ${limit} questions. Ask them to submit or give one back, or choose another coach.`, { limit }),
  resubmissionPending: () => new AppError(HttpStatus.CONFLICT, 'RESUBMISSION_PENDING',
    'A replacement answer is expected for this paper, so it cannot be marked yet. Choose another paper.'),
  claimLost: (reason: LostReason) => new AppError(HttpStatus.CONFLICT, 'CLAIM_LOST', LOST_TEXT[reason] ?? LOST_TEXT.EXPIRED, { reason }),
  taskChanged: (current: Record<string, unknown>) => new AppError(HttpStatus.CONFLICT, 'TASK_CHANGED',
    'Someone else acted on this question a moment ago. Reload to see the latest before acting.', current),
  markingChanged: (revision: number) => new AppError(HttpStatus.CONFLICT, 'MARKING_CHANGED',
    'Your marks were changed somewhere else (another tab or device) since you opened this page. Reload, then save again.', { revision }),
  marksInvalid: (max: number) => new AppError(HttpStatus.BAD_REQUEST, 'MARKS_INVALID',
    `Give a whole number of marks from 0 to ${max}.`, { max }),
  marksIncomplete: () => new AppError(HttpStatus.BAD_REQUEST, 'MARKS_INCOMPLETE', 'Give the marks for this question before submitting.'),
  decisionRequired: () => new AppError(HttpStatus.CONFLICT, 'DECISION_REQUIRED',
    'A second assessment exists for this question: the subject Head Coach decides the mark (first, second or adjusted).'),
  secondNotSubmitted: () => new AppError(HttpStatus.CONFLICT, 'SECOND_NOT_SUBMITTED',
    'The second assessment has not been submitted yet. Wait for it, or cancel it with a reason.'),
  reasonRequired: () => new AppError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', 'Give a reason (3 to 500 characters).'),
  noQuestions: () => new AppError(HttpStatus.CONFLICT, 'NO_QUESTIONS', 'Question marking needs at least one question. Add the questions first.'),
  markingStarted: () => new AppError(HttpStatus.CONFLICT, 'MARKING_STARTED',
    'Marking has already begun on this test, so its marking mode can no longer change.'),
  structureFrozen: () => new AppError(HttpStatus.CONFLICT, 'STRUCTURE_FROZEN',
    'Marking has begun on this test, so its questions can no longer be changed here. Contact the platform owner for a correction plan.'),
};

const LOST_TEXT: Record<string, string> = {
  EXPIRED: 'This question is no longer held by you: it was given back after 30 minutes without activity. Your saved draft is kept in the history for the Head Coach. If you take it again, you start afresh.',
  REASSIGNED: 'The Head Coach gave this question to another coach. Your saved draft is kept in the history for the Head Coach.',
  RELEASED_BY_STAFF: 'The Head Coach released this question. Your saved draft is kept in the history for the Head Coach.',
  AUTHORISATION_LOST: 'You can no longer mark this question: your authorisation for it, or for the subject, was removed. Ask the Head Coach if this is unexpected.',
  RELEASED: 'You gave this question back. Go to the list to choose a task.',
  SUBMITTED: 'You already submitted this question.',
  CANCELLED: 'This second assessment was cancelled by the Head Coach.',
};

/** Whole marks between 0 and max, or null (not marked yet). */
export function validMarks(marks: unknown, max: number): marks is number | null {
  return marks === null || (typeof marks === 'number' && Number.isInteger(marks) && marks >= 0 && marks <= max);
}
