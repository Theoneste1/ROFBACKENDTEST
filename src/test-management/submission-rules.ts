/**
 * Test Management (WS3, Phase 2) — the pure rules of deadlines, eligibility, answer formats and submission tracking,
 * shared by the services and unit-tested on their own. Every "now" passed in here is DATABASE time
 * (TestDeadlineService.now): a browser clock or a crafted request never moves a deadline.
 *
 *   Applicable deadline (one rule for every caller):
 *     the latest of the test's closesAt and the ACTIVE (not cancelled) extensions that apply to this submission:
 *       - a whole-test (TEST) extension: always;
 *       - a STUDENT extension: when it names this student (whoever submits for them);
 *       - a TEACHER extension: only when that teacher is the one submitting (for a verified student of their own
 *         schools — the submit route checks that); never for the student's own submissions or another teacher's.
 *     A student extension AND a teacher extension both applying → the later of the two. The test's own closesAt and
 *     originalClosesAt are never changed by an extension.
 *   A submission is accepted up to and including the deadline instant; one millisecond later it is refused.
 *
 *   Eligibility of a student for a test: the test is PUBLISHED and has opened (opensAt ≤ now); the student account is a
 *   STUDENT that is ACTIVE (approved, activated, not suspended / deactivated / archived); the student's DIVISION — their
 *   Olympiad level (owner 2026-11-21: Junior, Middle, Senior or one an Administrator created) — is the test's (ALL = any
 *   student). The division follows the grade (the division whose suggested grades hold it) unless a Coach or a User
 *   Manager set it, so the grade itself never decides.
 *
 *   Answer formats: UPLOAD_ONLY — pages, no typed answer; TYPED_ONLY — a typed answer, no pages; BOTH — a typed answer
 *   and/or pages (at least one).
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { fileNameFromTitle } from './test-rules.js';

export type ExtensionKind = 'TEST' | 'STUDENT' | 'TEACHER';
export type SubmitterRole = 'STUDENT' | 'TEACHER';
export type AnswerFormat = 'UPLOAD_ONLY' | 'TYPED_ONLY' | 'BOTH';
/** A test's level: a division code (JUNIOR, MIDDLE, SENIOR or one an Administrator created) or ALL. */
export type TestDivisionValue = string;
export const ALL_DIVISIONS = 'ALL';

/** Pages of one version (photos of handwritten sheets, or PDFs). */
export const MAX_ANSWER_PAGES = 30;
/** Characters of a typed answer. */
export const MAX_TYPED_ANSWER = 50_000;

export interface ExtensionLike {
  id: string;
  kind: ExtensionKind;
  studentId: string | null;
  teacherId: string | null;
  newDeadline: Date;
  cancelledAt: Date | null;
}

/** Who is submitting (or about to): the student themself, or a teacher (by id). */
export type Submitter = { role: 'STUDENT' } | { role: 'TEACHER'; teacherId: string };

export interface ApplicableDeadline {
  /** The deadline that applies (never earlier than the test's closesAt). */
  deadline: Date;
  /** The extension that gave it, or null when it is the test's own closesAt. */
  extensionId: string | null;
  extensionKind: ExtensionKind | null;
  /** The deadline is later than the test's own closesAt (an extension applies). */
  extended: boolean;
}

/** Whether an (active) extension applies to this student's submission by this submitter. */
export function extensionApplies(e: ExtensionLike, studentId: string, submitter: Submitter): boolean {
  if (e.cancelledAt !== null) return false;
  switch (e.kind) {
    case 'TEST':    return true;
    case 'STUDENT': return e.studentId === studentId;
    case 'TEACHER': return submitter.role === 'TEACHER' && e.teacherId === submitter.teacherId;
    default:        return false;
  }
}

/** The ONE deadline rule (see the file header). Ties keep the earlier-listed source: test, then student, then teacher. */
export function applicableDeadline(
  closesAt: Date, extensions: readonly ExtensionLike[], studentId: string, submitter: Submitter,
): ApplicableDeadline {
  let best: ApplicableDeadline = { deadline: closesAt, extensionId: null, extensionKind: null, extended: false };
  const order: Record<ExtensionKind, number> = { TEST: 0, STUDENT: 1, TEACHER: 2 };
  const applying = extensions.filter((e) => extensionApplies(e, studentId, submitter)).sort((a, b) => order[a.kind] - order[b.kind]);
  for (const e of applying) {
    if (e.newDeadline.getTime() > best.deadline.getTime()) {
      best = { deadline: e.newDeadline, extensionId: e.id, extensionKind: e.kind, extended: true };
    }
  }
  return best;
}

/** Inclusive: a submission at the deadline instant is on time; one millisecond later it is late. */
export function beforeDeadline(now: Date, deadline: Date): boolean {
  return now.getTime() <= deadline.getTime();
}

/** Where a student's level comes from: their division (`division.code`, or `divisionCode`). */
export interface LevelSource { division?: { code: string } | null; divisionCode?: string | null }

/** The student's level (their division's code) as test eligibility uses it; null: none (only ALL tests). */
export function levelOf(s: LevelSource): string | null {
  return s.division?.code ?? s.divisionCode ?? null;
}

/** The test's level accepts this student (ALL: everyone). */
export function divisionMatches(test: TestDivisionValue, student: LevelSource): boolean {
  if (test === ALL_DIVISIONS) return true;
  return levelOf(student) === test;
}

/** Database filter: students of this division (a test's level, or a list filter), by code. */
export function levelWhere(code: string): { division: { code: string } } {
  return { division: { code } };
}

export interface EligibilityTest { status: string; opensAt: Date; division: TestDivisionValue }
export interface EligibilityStudent {
  role: string; accountStatus: string; isActive: boolean; isApproved: boolean; activatedAt: Date | null;
  gradeLevel: string | null; division?: { code: string } | null; divisionCode?: string | null;
}

export type EligibilityProblem = 'TEST_NOT_PUBLISHED' | 'TEST_NOT_OPEN' | 'NOT_A_STUDENT' | 'ACCOUNT_NOT_ACTIVE' | 'DIVISION_MISMATCH';

/** Why this student may not submit to this test now (empty: eligible). The deadline is checked separately. */
export function eligibilityProblems(test: EligibilityTest, student: EligibilityStudent, now: Date): EligibilityProblem[] {
  const out: EligibilityProblem[] = [];
  if (test.status !== 'PUBLISHED') out.push('TEST_NOT_PUBLISHED');
  else if (test.opensAt.getTime() > now.getTime()) out.push('TEST_NOT_OPEN');
  if (student.role !== 'STUDENT') out.push('NOT_A_STUDENT');
  if (student.accountStatus !== 'ACTIVE' || !student.isActive || !student.isApproved || student.activatedAt === null) out.push('ACCOUNT_NOT_ACTIVE');
  if (!divisionMatches(test.division, student)) out.push('DIVISION_MISMATCH');
  return out;
}

const ELIGIBILITY_ERRORS: Record<EligibilityProblem, [HttpStatus, string]> = {
  TEST_NOT_PUBLISHED: [HttpStatus.NOT_FOUND, 'This test is not available.'],
  TEST_NOT_OPEN:      [HttpStatus.CONFLICT, 'This test has not opened yet.'],
  NOT_A_STUDENT:      [HttpStatus.FORBIDDEN, 'Only student accounts submit answers to a test.'],
  ACCOUNT_NOT_ACTIVE: [HttpStatus.CONFLICT, 'The student account is not active.'],
  DIVISION_MISMATCH:  [HttpStatus.FORBIDDEN, 'This test is for another Olympiad level.'],
};

/** Throws the first problem: 404 TEST_NOT_PUBLISHED, 409 TEST_NOT_OPEN / ACCOUNT_NOT_ACTIVE, 403 NOT_A_STUDENT / DIVISION_MISMATCH. */
export function assertEligible(test: EligibilityTest, student: EligibilityStudent, now: Date): void {
  const [first] = eligibilityProblems(test, student, now);
  if (!first) return;
  const [status, message] = ELIGIBILITY_ERRORS[first];
  throw new AppError(status, first, message, first === 'TEST_NOT_OPEN' ? { opensAt: test.opensAt.toISOString() } : undefined);
}

/** 409 DEADLINE_PASSED (late: blocked) after the applicable deadline. */
export function assertBeforeDeadline(now: Date, d: ApplicableDeadline): void {
  if (!beforeDeadline(now, d.deadline)) {
    throw new AppError(HttpStatus.CONFLICT, 'DEADLINE_PASSED', 'The deadline for this test has passed.', { deadline: d.deadline.toISOString() });
  }
}

/** The answer a version would hold, against the test's format (400 with a precise code). */
export function assertAnswerFormat(format: AnswerFormat, typedAnswer: string | null, pageCount: number): void {
  const typed = typedAnswer !== null && typedAnswer.trim().length > 0;
  if (format === 'UPLOAD_ONLY') {
    if (typed) throw new AppError(HttpStatus.BAD_REQUEST, 'TYPED_ANSWER_NOT_ALLOWED', 'This test takes uploaded pages only.');
    if (pageCount === 0) throw new AppError(HttpStatus.BAD_REQUEST, 'PAGES_REQUIRED', 'Upload at least one page.');
  } else if (format === 'TYPED_ONLY') {
    if (pageCount > 0) throw new AppError(HttpStatus.BAD_REQUEST, 'UPLOAD_NOT_ALLOWED', 'This test takes a typed answer only.');
    if (!typed) throw new AppError(HttpStatus.BAD_REQUEST, 'TYPED_ANSWER_REQUIRED', 'Type your answer.');
  } else if (!typed && pageCount === 0) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'ANSWER_REQUIRED', 'Type an answer or upload at least one page.');
  }
}

/** 400 UPLOAD_NOT_ALLOWED: a TYPED_ONLY test takes no pages (checked before a page is stored). */
export function assertUploadsAllowed(format: AnswerFormat): void {
  if (format === 'TYPED_ONLY') throw new AppError(HttpStatus.BAD_REQUEST, 'UPLOAD_NOT_ALLOWED', 'This test takes a typed answer only.');
}

/**
 * The pending pages of one upload, as a version would commit them: numbered 1…n without a gap, and exactly
 * `expected` of them when the client says how many it sent. 409 PAGES_INCOMPLETE lists what is missing.
 */
export function assertPagesComplete(pageNumbers: readonly number[], expected: number | undefined): void {
  const have = [...new Set(pageNumbers)].sort((a, b) => a - b);
  const n = expected ?? (have.length ? have[have.length - 1] : 0);
  const missing: number[] = [];
  for (let i = 1; i <= n; i++) if (!have.includes(i)) missing.push(i);
  const extra = have.filter((p) => p > n);
  if (missing.length || extra.length) {
    throw new AppError(HttpStatus.CONFLICT, 'PAGES_INCOMPLETE', 'Some pages are missing; upload them again, then submit.', { missing, extra, expected: n });
  }
  if (n > MAX_ANSWER_PAGES) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_PAGES', `At most ${MAX_ANSWER_PAGES} pages.`, { max: MAX_ANSWER_PAGES });
  }
}

/** A student's place in submission tracking (Administrators and Head Coaches). */
export type TrackingState = 'SUBMITTED' | 'NOT_SUBMITTED' | 'LATE_BLOCKED';

export function trackingState(hasSubmission: boolean, now: Date, deadline: Date): TrackingState {
  if (hasSubmission) return 'SUBMITTED';
  return beforeDeadline(now, deadline) ? 'NOT_SUBMITTED' : 'LATE_BLOCKED';
}

/** A test's state for the people who answer it. */
export type AnswerWindow = 'UPCOMING' | 'OPEN' | 'CLOSED';

export function answerWindow(opensAt: Date, deadline: Date, now: Date): AnswerWindow {
  if (opensAt.getTime() > now.getTime()) return 'UPCOMING';
  return beforeDeadline(now, deadline) ? 'OPEN' : 'CLOSED';
}

/** Neutral name of an answer page (no student, school or file name): page-3.jpg. */
export function answerPageName(pageNumber: number, mimeType: string): string {
  return `page-${pageNumber}.${answerExtension(mimeType)}`;
}

function answerExtension(mimeType: string): string {
  return mimeType === 'application/pdf' ? 'pdf'
    : mimeType === 'image/jpeg' ? 'jpg'
    : mimeType.startsWith('image/') ? mimeType.slice(6).replace(/[^a-z0-9]/g, '') || 'img'
    : 'bin';
}

/** Who wrote the sheet and for which test — for the people who may see the student's identity. */
export interface SheetNaming { studentName: string; testTitle: string; pageCount: number }

/**
 * An answer sheet's name (owner 2026-11-23): the student's full name and the test's title — "Aline Uwase - Junior
 * Mathematics Competition.pdf"; with several pages, " - page 2" is added. For the student, their teachers and staff
 * (who see the identity anyway). Never for markers: marking is blind, they keep answerPageName (page-2.jpg).
 * Characters a file name cannot hold are removed (fileNameFromTitle); without a usable name: page-N as before.
 */
export function answerSheetName(pageNumber: number, mimeType: string, naming: SheetNaming): string {
  const base = fileNameFromTitle(`${naming.studentName.trim()} - ${naming.testTitle.trim()}`.replace(/^ - | - $/g, ''));
  if (!base) return answerPageName(pageNumber, mimeType);
  return `${base}${naming.pageCount > 1 ? ` - page ${pageNumber}` : ''}.${answerExtension(mimeType)}`;
}

/** Opaque public code of a submission: 8 characters from an unambiguous alphabet, as XXXX-XXXX. No identity in it. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function formatPublicCode(randomIndexes: readonly number[]): string {
  const chars = randomIndexes.slice(0, 8).map((i) => CODE_ALPHABET[i % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

/**
 * Phase 1 gaps closed now that submissions exist — what a test keeps once ANY student has submitted (409
 * TEST_LOCKED_BY_SUBMISSIONS names the fields): its subject, division, answer format, opening time, deadline (later
 * deadlines are given by extensions, which never change closesAt) and maximum marks; its questions' number, order and
 * marks; its paper. Still editable: the title, a question's wording (typo fixes), the marking guide. Unpublishing and
 * deleting are refused (409 TEST_HAS_SUBMISSIONS).
 */
export const LOCKED_AFTER_SUBMISSIONS = ['subjectId', 'division', 'answerFormat', 'opensAt', 'closesAt', 'maxMarks'] as const;

export function lockedFieldsIn(changes: Record<string, unknown>): string[] {
  return LOCKED_AFTER_SUBMISSIONS.filter((f) => changes[f] !== undefined);
}

export function lockedBySubmissions(what: string, fields?: readonly string[]) {
  return new AppError(HttpStatus.CONFLICT, 'TEST_LOCKED_BY_SUBMISSIONS',
    `Students have already submitted to this test: ${what} can no longer change.` +
      (fields?.includes('closesAt') ? ' Give a later deadline with an extension.' : ''),
    { ...(fields && { fields: [...fields] }) });
}
