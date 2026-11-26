import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, MaxLength, Min,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { MAX_QUESTIONS } from '../test-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const REVIEW_LIST_STATUSES = ['SUBMITTED', 'ASSIGNED', 'MARKING_IN_PROGRESS', 'MARKED', 'APPROVED', 'RETURNED', 'AWAITING_SECOND_MARKING', 'PUBLISHED'] as const;
/** The coach queue's filter: one state, or TO_MARK (not started + in progress, returned included: everything still to do). */
export const QUEUE_STATES = ['NOT_STARTED', 'IN_PROGRESS', 'MARKED', 'TO_MARK'] as const;
export const MARKER_KINDS = ['FIRST', 'SECOND'] as const;
export const CHOICES = ['FIRST', 'SECOND', 'ADJUSTMENT'] as const;
export const HISTORY_TYPES = ['status', 'marks', 'reviews'] as const;
/** Largest number of coaches one distribution may use. */
export const MAX_DISTRIBUTION_COACHES = 100;
/** Largest number of submissions one manual assignment may name. */
export const MAX_MANUAL_ASSIGN = 500;
/** A marker's comment (overall or per question). */
export const MAX_MARK_COMMENT = 2000;

// ── Distribution (tests.distribute) ─────────────────────────────────────────────

/** POST /admin/tests/:id/marking/distribute */
export class DistributeMarkingDto {
  /** The coaches to share the unassigned, markable submissions between (each must be authorised for the subject). */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_DISTRIBUTION_COACHES) @ArrayUnique() @IsUUID('all', { each: true })
  coachIds: string[];

  /** Optional idempotency key of this request: a retry notifies nobody twice. */
  @IsOptional() @IsUUID()
  clientKey?: string;
}

/** POST /admin/tests/:id/marking/assign */
export class AssignMarkingDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_MANUAL_ASSIGN) @ArrayUnique() @IsUUID('all', { each: true })
  submissionIds: string[];

  @IsUUID()
  coachId: string;

  /** Optional (3–500 characters). */
  @IsOptional() @IsString() @Transform(trim) @Length(3, 500)
  reason?: string;
}

/** POST /admin/tests/:id/marking/submissions/:submissionId/reassign */
export class ReassignMarkingDto {
  @IsUUID()
  coachId: string;

  /** Mandatory (3–500 characters). */
  @IsString() @Transform(trim) @Length(3, 500)
  reason: string;

  /** Which marking moves: FIRST (default) or SECOND. */
  @IsOptional() @IsIn(MARKER_KINDS)
  kind?: (typeof MARKER_KINDS)[number];
}

// ── Review (tests.review; choose: tests.adjustMarks) ────────────────────────────

/** GET /admin/tests/:id/marking/submissions */
export class ListMarkingSubmissionsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(REVIEW_LIST_STATUSES)
  status?: (typeof REVIEW_LIST_STATUSES)[number];

  /** Submissions whose current FIRST or SECOND assignment is this coach's. */
  @IsOptional() @IsUUID()
  coachId?: string;

  /** Student name, username or submission code. */
  @IsOptional() @IsString() @Transform(trim) @MaxLength(100)
  q?: string;
}

/** Shared by every reviewer decision. */
class ReviewBaseDto {
  /** Optional idempotency key: the same key again returns the first answer (replayed: true). */
  @IsOptional() @IsUUID()
  clientKey?: string;

  /** Optional: the status the reviewer saw; another status now → 409 SUBMISSION_CHANGED. */
  @IsOptional() @IsIn(REVIEW_LIST_STATUSES)
  expectedStatus?: (typeof REVIEW_LIST_STATUSES)[number];
}

/** POST …/approve */
export class ApproveMarkingDto extends ReviewBaseDto {}

/** POST …/return */
export class ReturnMarkingDto extends ReviewBaseDto {
  /** Mandatory (3–2000 characters): what the marker must correct. */
  @IsString() @Transform(trim) @Length(3, MAX_MARK_COMMENT)
  comment: string;

  /** Which marking (when both a first and a second marking were submitted). */
  @IsOptional() @IsIn(MARKER_KINDS)
  kind?: (typeof MARKER_KINDS)[number];
}

/** POST …/second-marking */
export class RequestSecondMarkingDto extends ReviewBaseDto {
  /** Another authorised coach (never the first marker). */
  @IsUUID()
  coachId: string;

  @IsOptional() @IsString() @Transform(trim) @Length(3, 500)
  reason?: string;
}

/** POST …/unlock */
export class UnlockMarkingDto extends ReviewBaseDto {
  /** Mandatory (3–500 characters). */
  @IsString() @Transform(trim) @Length(3, 500)
  reason: string;
}

/** A question's marks and comment. */
export class ScoreInputDto {
  @IsUUID()
  questionId: string;

  /** Whole marks (G7), 0 to the question's maximum; null or absent: not marked yet (drafts). */
  @IsOptional() @IsInt() @Min(0)
  marks?: number | null;

  @IsOptional() @IsString() @MaxLength(MAX_MARK_COMMENT)
  comment?: string | null;
}

/** Marks of a marking: per question (tests with questions) or one total. */
export class MarksInputDto {
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_QUESTIONS) @ValidateNested({ each: true }) @Type(() => ScoreInputDto)
  scores?: ScoreInputDto[];

  /** Tests without questions: whole marks, 0 to the test's maximum. */
  @IsOptional() @IsInt() @Min(0)
  totalMarks?: number | null;

  @IsOptional() @IsString() @MaxLength(MAX_MARK_COMMENT)
  comment?: string | null;
}

/** POST …/choose — the subject's Head Coach only (G4). */
export class ChooseMarkDto extends ReviewBaseDto {
  /** FIRST, SECOND, or ADJUSTMENT (the marks below). */
  @IsIn(CHOICES)
  source: (typeof CHOICES)[number];

  /** Mandatory (3–500 characters). */
  @IsString() @Transform(trim) @Length(3, 500)
  reason: string;

  /** ADJUSTMENT only: the complete adjusted marks. */
  @IsOptional() @ValidateNested() @Type(() => MarksInputDto)
  marks?: MarksInputDto;
}

/** GET /admin/tests/:id/marking/history */
export class MarkingHistoryQueryDto extends PaginationQueryDto {
  /** status (default): status changes; marks: the mark-change log; reviews: reviewer decisions. */
  @IsOptional() @IsIn(HISTORY_TYPES)
  type?: (typeof HISTORY_TYPES)[number];

  @IsOptional() @IsUUID()
  submissionId?: string;
}

// ── The marker (tests.mark) ─────────────────────────────────────────────────────

/** GET /marking/queue */
export class MarkingQueueQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(QUEUE_STATES)
  state?: (typeof QUEUE_STATES)[number];

  @IsOptional() @IsUUID()
  testId?: string;
}

/** PUT /marking/submissions/:code/marking — the whole draft (what is not given is not marked yet). */
export class SaveMarkingDto extends MarksInputDto {
  /** Optional: the revision the marker started from; another one now → 409 MARKING_CHANGED. */
  @IsOptional() @IsInt() @Min(1)
  expectedRevision?: number;
}

/** POST /marking/submissions/:code/marking/submit — the final marks, submitted for approval. */
export class SubmitMarkingDto extends SaveMarkingDto {}
