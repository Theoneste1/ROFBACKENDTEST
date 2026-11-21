import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, MaxLength, Min } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { MAX_ANSWER_PAGES, MAX_TYPED_ANSWER } from '../submission-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const EXTENSION_KINDS = ['TEST', 'STUDENT', 'TEACHER'] as const;
export const EXTENSION_STATES = ['active', 'cancelled', 'all'] as const;
export const TRACKING_STATES = ['SUBMITTED', 'NOT_SUBMITTED', 'LATE_BLOCKED', 'UNDER_EXTENSION'] as const;
export const STUDENT_DIVISIONS = ['JUNIOR', 'MIDDLE', 'SENIOR'] as const;

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
  @IsOptional() @IsIn(STUDENT_DIVISIONS)
  division?: (typeof STUDENT_DIVISIONS)[number];

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
  @IsOptional() @IsIn(['JUNIOR', 'MIDDLE', 'SENIOR'])
  division?: 'JUNIOR' | 'MIDDLE' | 'SENIOR';

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
