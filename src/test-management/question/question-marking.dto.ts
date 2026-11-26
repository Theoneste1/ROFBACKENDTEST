import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { COACH_VIEWS } from './question-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const TASK_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW', 'RETURNED', 'AWAITING_SECOND', 'APPROVED', 'CLOSED', 'CANCELLED'] as const;

/** GET /marking/tasks */
export class QuestionQueueQueryDto extends PaginationQueryDto {
  @IsOptional() @IsIn(COACH_VIEWS)
  view?: (typeof COACH_VIEWS)[number];

  @IsOptional() @IsUUID()
  testId?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  question?: number;
}

/** PUT …/marks and POST …/submit: this question only (no question field: the task in the URL decides it). */
export class QuestionMarksDto {
  /** Whole marks from 0 to the question's maximum; null = not marked yet. */
  @IsOptional() @IsInt() @Min(0)
  marks?: number | null;

  @IsOptional() @IsString() @MaxLength(2000)
  comment?: string | null;

  /** The revision the page last saw; another one now → 409 MARKING_CHANGED (another tab or device). */
  @IsOptional() @IsInt() @Min(1)
  expectedRevision?: number;
}

/** PATCH /admin/tests/:id/question-marking/mode */
export class MarkingModeDto {
  @IsIn(['PAPER', 'QUESTION'])
  mode!: 'PAPER' | 'QUESTION';
}

/** PUT …/questions/:questionId/markers */
export class QuestionMarkersDto {
  @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID('all', { each: true })
  add?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(100) @ArrayUnique() @IsUUID('all', { each: true })
  remove?: string[];

  /** Required when removing anyone (3–500 characters). */
  @IsOptional() @IsString() @Transform(trim) @Length(3, 500)
  reason?: string;
}

/** GET …/tasks */
export class QuestionTasksQueryDto extends PaginationQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200)
  question?: number;

  @IsOptional() @IsIn(TASK_STATUSES)
  status?: (typeof TASK_STATUSES)[number];

  @IsOptional() @IsIn(['FIRST', 'SECOND'])
  round?: 'FIRST' | 'SECOND';

  @IsOptional() @IsUUID()
  coachId?: string;

  @IsOptional() @IsString() @Matches(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/)
  code?: string;
}

/** GET …/history */
export class QuestionHistoryQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID()
  taskId?: string;
}

export class ReasonDto {
  @IsString() @Transform(trim) @Length(3, 500)
  reason!: string;
}

export class AssignQuestionTaskDto extends ReasonDto {
  @IsUUID()
  coachId!: string;
}

/** Shared by review actions: what the reviewer saw (another state now → 409 TASK_CHANGED). */
export class QuestionReviewDto {
  @IsOptional() @IsIn(TASK_STATUSES)
  expectedStatus?: (typeof TASK_STATUSES)[number];

  @IsOptional() @IsInt() @Min(0)
  cycleSeen?: number;
}

export class ReturnQuestionDto extends QuestionReviewDto {
  @IsString() @Transform(trim) @Length(3, 500)
  reason!: string;
}

export class SecondAssessmentDto extends QuestionReviewDto {
  /** Optional: a named coach (the same checks as an assignment); otherwise the second task goes to the pool. */
  @IsOptional() @IsUUID()
  coachId?: string;

  @IsOptional() @IsString() @Transform(trim) @Length(3, 500)
  reason?: string;
}

export class DecideQuestionDto extends QuestionReviewDto {
  @IsIn(['FIRST', 'SECOND', 'ADJUSTED'])
  source!: 'FIRST' | 'SECOND' | 'ADJUSTED';

  /** ADJUSTED only: whole marks within the question's maximum. */
  @IsOptional() @IsInt() @Min(0)
  marks?: number;

  @IsString() @Transform(trim) @Length(3, 500)
  reason!: string;
}

export class ReopenQuestionDto {
  @IsString() @Transform(trim) @Length(3, 500)
  reason!: string;

  @IsIn(['RETURNED', 'SUBMITTED'])
  to!: 'RETURNED' | 'SUBMITTED';
}

export class WordingCorrectionDto {
  @IsString() @Transform(trim) @Length(1, 5000)
  prompt!: string;

  @IsString() @Transform(trim) @Length(3, 500)
  reason!: string;
}

class StructureQuestionDto {
  @IsUUID()
  id!: string;

  @IsInt() @Min(1) @Max(200)
  order!: number;

  @IsInt() @Min(1)
  maxMarks!: number;
}

export class StructureCorrectionDto {
  @IsOptional() @IsInt() @Min(1)
  maxMarks?: number;

  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => StructureQuestionDto)
  questions!: StructureQuestionDto[];

  @IsString() @Transform(trim) @Length(3, 500)
  reason!: string;
}
