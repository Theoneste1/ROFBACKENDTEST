/**
 * Test Management (WS3, Phase 1) — the pure rules, shared by the services and unit-tested on their own.
 *
 *   - whole-number marks (G7): a test's maxMarks and every question's maxMarks are positive integers;
 *   - the window: opensAt strictly before closesAt (server time; the database CHECK is the backstop);
 *   - the question sum rule: when a test has questions, their marks add up EXACTLY to the test's maxMarks before it can
 *     be published and while it is published; a draft may be incomplete (below) but never above the total;
 *   - subject scope: Administrators act in every subject, a Head Coach only in the subjects they head.
 */
import { HttpStatus } from '@nestjs/common';

import { scopeForbidden } from '../common/access/access.service.js';
import { AppError } from '../common/errors/app-error.js';

/** Largest maxMarks of a test (and so of a question). Whole numbers only (G7). */
export const MAX_TEST_MARKS = 1000;
/** Most questions a test can have. */
export const MAX_QUESTIONS = 100;

export type TestStatusValue = 'DRAFT' | 'PUBLISHED';

/** 400 INVALID_TEST_WINDOW unless opensAt is strictly before closesAt. */
export function assertWindow(opensAt: Date, closesAt: Date): void {
  if (!(opensAt.getTime() < closesAt.getTime())) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_TEST_WINDOW', 'The opening time must be before the closing time. Change one of them.',
      { opensAt: opensAt.toISOString(), closesAt: closesAt.toISOString() });
  }
}

export interface QuestionTotals {
  count: number;
  /** Sum of the questions' maxMarks. */
  total: number;
  /** No questions (marked as one total), or questions adding up exactly to the test's maxMarks. */
  complete: boolean;
  /** Marks still to distribute (negative: over the total — never stored). */
  remaining: number;
}

export function questionTotals(maxMarks: number, questionMarks: readonly number[]): QuestionTotals {
  const total = questionMarks.reduce((a, b) => a + b, 0);
  return { count: questionMarks.length, total, complete: questionMarks.length === 0 || total === maxMarks, remaining: maxMarks - total };
}

/**
 * The question sum rule for a state the caller is about to store: never above the test's maxMarks (400
 * QUESTION_MARKS_EXCEED_TOTAL); for a PUBLISHED test, exactly equal when there are questions (409 QUESTION_MARKS_MISMATCH).
 */
export function assertQuestionMarks(status: TestStatusValue, maxMarks: number, questionMarks: readonly number[]): void {
  const t = questionTotals(maxMarks, questionMarks);
  if (t.total > maxMarks) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'QUESTION_MARKS_EXCEED_TOTAL',
      `The questions would total ${t.total} marks, more than the test's ${maxMarks}.`, { maxMarks, questionMarks: t.total });
  }
  if (status === 'PUBLISHED' && !t.complete) {
    throw new AppError(HttpStatus.CONFLICT, 'QUESTION_MARKS_MISMATCH',
      `A published test's questions must total exactly ${maxMarks} marks (they would total ${t.total}). Unpublish it to rework the questions.`,
      { maxMarks, questionMarks: t.total });
  }
}

/** 400 TEST_MAX_MARKS_BELOW_QUESTIONS when a new maxMarks is below the questions' total. */
export function assertMaxMarksCoversQuestions(maxMarks: number, questionMarks: readonly number[]): void {
  const t = questionTotals(maxMarks, questionMarks);
  if (t.total > maxMarks) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'TEST_MAX_MARKS_BELOW_QUESTIONS',
      `The questions already total ${t.total} marks; the test's maximum cannot be lower.`, { maxMarks, questionMarks: t.total });
  }
}

/**
 * What stops a test from being published (empty: it can be). A test needs a paper or at least one question; its questions
 * total exactly its maxMarks; it must not have closed already.
 */
export function publishProblems(test: { maxMarks: number; closesAt: Date; hasPaper: boolean; questionMarks: readonly number[] }, now: Date): string[] {
  const problems: string[] = [];
  if (!test.hasPaper && test.questionMarks.length === 0) problems.push('NO_PAPER_OR_QUESTIONS');
  if (!questionTotals(test.maxMarks, test.questionMarks).complete) problems.push('QUESTION_MARKS_MISMATCH');
  if (test.closesAt.getTime() <= now.getTime()) problems.push('ALREADY_CLOSED');
  return problems;
}

/** 409 TEST_NOT_READY listing what is missing. */
export function assertPublishable(test: Parameters<typeof publishProblems>[0], now: Date): void {
  const problems = publishProblems(test, now);
  if (problems.length) {
    throw new AppError(HttpStatus.CONFLICT, 'TEST_NOT_READY', 'This test cannot be published yet.', { problems });
  }
}

/**
 * originalClosesAt after a deadline change: it follows closesAt while the test was never published, and is kept
 * unchanged once it was (the deadline then "moved").
 */
export function nextOriginalClosesAt(test: { publishedAt: Date | null; originalClosesAt: Date }, closesAt: Date): Date {
  return test.publishedAt === null ? closesAt : test.originalClosesAt;
}

/** A caller's subject scope (AccessService.programmeScope): 'all' for Administrators, the headed subjects for a Head Coach. */
export type SubjectScope = 'all' | readonly string[];

export function inSubjectScope(scope: SubjectScope, disciplineId: string): boolean {
  return scope === 'all' || scope.includes(disciplineId);
}

/** 403 SCOPE_FORBIDDEN outside the caller's subjects (Head Coaches: only the subjects they head). */
export function assertSubjectInScope(scope: SubjectScope, disciplineId: string): void {
  if (!inSubjectScope(scope, disciplineId)) {
    throw scopeForbidden('You can manage tests only in the subjects you head.', { subjectId: disciplineId });
  }
}

/** Prisma `where` fragment for the tests a scope may list (none headed → nothing). */
export function subjectFilter(scope: SubjectScope): { disciplineId?: { in: string[] } } {
  return scope === 'all' ? {} : { disciplineId: { in: [...scope] } };
}

/** Neutral download name for a test file: never the uploader's own file name. */
export function neutralFileName(kind: 'PAPER' | 'MARKING_GUIDE', storageKey: string): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(storageKey)?.[1]?.toLowerCase() ?? 'bin';
  return `${kind === 'PAPER' ? 'test-paper' : 'marking-guide'}.${ext}`;
}
