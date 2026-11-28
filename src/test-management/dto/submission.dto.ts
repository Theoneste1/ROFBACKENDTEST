import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { MAX_ANSWER_PAGES, MAX_TYPED_ANSWER } from '../submission-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const EXTENSION_KINDS = ['TEST', 'STUDENT', 'TEACHER'] as const;
export const EXTENSION_STATES = ['active', 'cancelled', 'all'] as const;
export const TRACKING_STATES = ['SUBMITTED', 'NOT_SUBMITTED', 'LATE_BLOCKED', 'UNDER_EXTENSION'] as const;
/** A division code (JUNIOR, MIDDLE, SENIOR or one an Administrator created): 2–30 capitals, digits or underscores. */
export const DIVISION_CODE = /^[A-Z][A-Z0-9_]{1,29}$/;

// ── Extensions (Administrators; Head Coaches of the subject) ─────────────────────

/** POST /admin/tests/:id/extensions */
export class CreateTestExtensionDto {
  /** TEST (every student), STUDENT (one student) or TEACHER (one teacher's submissions for their own-school students). */
  @IsIn(EXTENSION_KINDS)
  kind: (typeof EXTENSION_KINDS)[number];

  /** The student (kind STUDENT). */
  @IsOptional() @IsUUID()
  studentId?: string;

  /** The teacher (kind TEACHER). */
  @IsOptional() @IsUUID()
  teacherId?: string;

  /** ISO 8601 date-time; later than the test's deadline and than now (database time). */
  @IsISO8601({ strict: true })
  newDeadline: string;

  /** Mandatory (3–500 characters). */
  @IsString() @Transform(trim) @Length(3, 500)
  reason: string;
}

/** PATCH /admin/tests/:id/extensions/:extensionId — a new deadline and/or reason; the reason for the change is mandatory. */
export class UpdateTestExtensionDto {
  @IsOptional() @IsISO8601({ strict: true })
  newDeadline?: string;

  /** Mandatory (3–500 characters): why it changes (it becomes the extension's reason). */
  @IsString() @Transform(trim) @Length(3, 500)
  reason: string;
}

/** POST /admin/tests/:id/extensions/:extensionId/cancel */
export class CancelTestExtensionDto {
  /** Mandatory (3–500 characters). */
  @IsString() @Transform(trim) @Length(3, 500)
  reason: string;
}

/** GET /admin/tests/:id/extensions */
export class ListTestExtensionsQueryDto extends PaginationQueryDto {
  /** active (default: not cancelled), cancelled or all. */
  @IsOptional() @IsIn(EXTENSION_STATES)
  state?: (typeof EXTENSION_STATES)[number];

  @IsOptional() @IsIn(EXTENSION_KINDS)
  kind?: (typeof EXTENSION_KINDS)[number];
}

/** GET /admin/tests/:id/extension-targets — students (of the test's division) or teachers to extend for. */
export class ExtensionTargetsQueryDto extends PaginationQueryDto {
  @IsIn(['STUDENT', 'TEACHER'])
  kind: 'STUDENT' | 'TEACHER';

  /** Part of the first name, last name or username (1–100 characters). */
  @IsOptional() @IsString() @Transform(trim) @Length(1, 100)
  q?: string;
}

// ── Tracking (Administrators; Head Coaches of the subject) ───────────────────────

/** GET /admin/tests/:id/submissions */
export class ListTestSubmissionsQueryDto extends PaginationQueryDto {
  /** SUBMITTED, NOT_SUBMITTED, LATE_BLOCKED (no submission, deadline passed) or UNDER_EXTENSION (an extension applies). */
  @IsOptional() @IsIn(TRACKING_STATES)
  status?: (typeof TRACKING_STATES)[number];

  @IsOptional() @IsUUID()
  schoolId?: string;

  /** The student's Olympiad level (owner 2026-11-21): JUNIOR, MIDDLE or SENIOR. */
  @IsOptional() @Matches(DIVISION_CODE, { message: 'division must be a division code.' })
  division?: string;

  /** Part of the student's first name, last name or username (1–100 characters). */
  @IsOptional() @IsString() @Transform(trim) @Length(1, 100)
  q?: string;
}

// ── Students and teachers ────────────────────────────────────────────────────────

/** GET /me/tests */
export class ListMyTestsQueryDto extends PaginationQueryDto {
  /** UPCOMING, OPEN or CLOSED (database time; the deadline includes any extension). */
  @IsOptional() @IsIn(['UPCOMING', 'OPEN', 'CLOSED'])
  window?: 'UPCOMING' | 'OPEN' | 'CLOSED';
}

/** GET /teacher/tests/:id/students */
export class ListTeacherTestStudentsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(['SUBMITTED', 'NOT_SUBMITTED', 'LATE_BLOCKED'])
  status?: 'SUBMITTED' | 'NOT_SUBMITTED' | 'LATE_BLOCKED';

  @IsOptional() @IsUUID()
  schoolId?: string;

  @IsOptional() @IsString() @Transform(trim) @Length(1, 100)
  q?: string;

  /** Competition level (owner 2026-11-21): JUNIOR (S1–S3) or SENIOR (S4–S6), from the student's grade. */
  /** The students' division (Olympiad level), by code. */
  @IsOptional() @Matches(DIVISION_CODE, { message: 'division must be a division code.' })
  division?: string;

  /** Olympiad subject (owner 2026-11-21): students who chose it among their Olympiad interests. */
  @IsOptional() @IsIn(['MATHEMATICS', 'COMPUTING', 'PHYSICS'])
  subject?: 'MATHEMATICS' | 'COMPUTING' | 'PHYSICS';
}

/**
 * POST …/submission — commit a version: the typed answer and/or the pages uploaded under `clientKey`. Sending the same
 * clientKey again never creates a second version (the first one is returned).
 */
export class SubmitTestAnswerDto {
  /** A UUID the client generates once per attempt; also the key its pages were uploaded under. */
  @IsUUID()
  clientKey: string;

  /** The typed answer (up to 50 000 characters), when the format allows it. */
  @IsOptional() @IsString() @MaxLength(MAX_TYPED_ANSWER)
  typedAnswer?: string;

  /** How many pages the client uploaded under clientKey (1…30); 409 PAGES_INCOMPLETE when some are missing. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(MAX_ANSWER_PAGES)
  pageCount?: number;
}

/** POST /admin/tests/:id/submissions/:submissionId/resubmission (owner 2026-11-21): why the locked answer is unlocked. */
export class AuthorizeResubmissionDto {
  /** 3–500 characters; recorded in the history and the audit log, and shown to the student and their teachers. */
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @Length(3, 500)
  reason: string;
}

// ── Reassign a submission (owner 2026-11-28) ────────────────────────────────────────

const SUBMISSION_STATUSES = ['SUBMITTED', 'ASSIGNED', 'MARKING_IN_PROGRESS', 'MARKED', 'APPROVED', 'PUBLISHED', 'RETURNED', 'AWAITING_SECOND_MARKING'] as const;

/** GET /admin/test-submissions: submitted answers across every test, for a correction. */
export class ListReassignableSubmissionsQueryDto extends PaginationQueryDto {
  /** Part of the student's first name, last name or username; the student's id; the paper's public code; part of the test title. */
  @IsOptional() @IsString() @Transform(trim) @Length(1, 100)
  q?: string;

  /** The test's subject (programme). */
  @IsOptional() @IsUUID()
  subjectId?: string;

  /** The submission's level (its ranking group): JUNIOR, MIDDLE, SENIOR or another division code. */
  @IsOptional() @Matches(DIVISION_CODE, { message: 'level must be a division code.' })
  level?: string;

  @IsOptional() @IsIn(SUBMISSION_STATUSES)
  status?: (typeof SUBMISSION_STATUSES)[number];

  @IsOptional() @IsUUID()
  testId?: string;
}

/** POST /admin/tests/:id/submissions/:submissionId/reassignment: the correct test and level, and why. */
export class ReassignSubmissionDto {
  /** The correct test: the current one to correct only the level, or another published test. */
  @IsUUID()
  testId: string;

  /** The correct level (division code); the destination test must be for every level or for this one. */
  @Matches(DIVISION_CODE, { message: 'level must be a division code.' })
  level: string;

  /** 5–500 characters; recorded in the audit log with the values before and after. */
  @Transform(trim)
  @IsString() @Length(5, 500)
  reason: string;

  /** The test the reviewer saw the answer under (optional): refused with SUBMISSION_CHANGED if it moved meanwhile. */
  @IsOptional() @IsUUID()
  expectedTestId?: string;
}
