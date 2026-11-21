import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, Min,
  ValidateNested,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { MAX_QUESTIONS, MAX_TEST_MARKS } from '../test-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export const TEST_DIVISIONS = ['JUNIOR', 'MIDDLE', 'SENIOR', 'ALL'] as const;
export const ANSWER_FORMATS = ['UPLOAD_ONLY', 'TYPED_ONLY', 'BOTH'] as const;
export const TEST_STATUSES = ['DRAFT', 'PUBLISHED'] as const;
/** The file kinds as they appear in the URL. */
export const TEST_FILE_KINDS = ['paper', 'marking-guide'] as const;
export type TestFileKindParam = (typeof TEST_FILE_KINDS)[number];

/** One question: its text and its whole-number maximum mark. */
export class TestQuestionInputDto {
  /** The question as shown to students and markers (1–5000 characters). */
  @IsString() @Transform(trim) @Length(1, 5000)
  prompt: string;

  /** Whole marks (G7), at least 1. */
  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_TEST_MARKS)
  maxMarks: number;
}

/** POST /admin/tests */
export class CreateTestDto {
  /** 3–200 characters. */
  @IsString() @Transform(trim) @Length(3, 200)
  title: string;

  /** The subject (Discipline id): Mathematics, Physics or Computing. A Head Coach: only a subject they head. */
  @IsUUID()
  subjectId: string;

  /** The Olympiad level: JUNIOR, MIDDLE or SENIOR (the students whose level it is), or ALL. Mandatory. */
  @IsIn(TEST_DIVISIONS)
  division: (typeof TEST_DIVISIONS)[number];

  /** How students answer: UPLOAD_ONLY, TYPED_ONLY or BOTH. */
  @IsIn(ANSWER_FORMATS)
  answerFormat: (typeof ANSWER_FORMATS)[number];

  /** ISO 8601 date-time; before closesAt. */
  @IsISO8601({ strict: true })
  opensAt: string;

  /** ISO 8601 date-time; after opensAt. */
  @IsISO8601({ strict: true })
  closesAt: string;

  /** Whole marks (G7), 1–1000. */
  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_TEST_MARKS)
  maxMarks: number;

  /** Optional questions, in order. Their marks may not exceed maxMarks (they must equal it before publishing). */
  @IsOptional() @IsArray() @ArrayMaxSize(MAX_QUESTIONS)
  @ValidateNested({ each: true }) @Type(() => TestQuestionInputDto)
  questions?: TestQuestionInputDto[];
}

/** PATCH /admin/tests/:id — any of the details. */
export class UpdateTestDto {
  @IsOptional() @IsString() @Transform(trim) @Length(3, 200)
  title?: string;

  /** Move the test to another subject (a Head Coach must head both). Drafts only. */
  @IsOptional() @IsUUID()
  subjectId?: string;

  @IsOptional() @IsIn(TEST_DIVISIONS)
  division?: (typeof TEST_DIVISIONS)[number];

  @IsOptional() @IsIn(ANSWER_FORMATS)
  answerFormat?: (typeof ANSWER_FORMATS)[number];

  @IsOptional() @IsISO8601({ strict: true })
  opensAt?: string;

  /** A new deadline. Once the test was published, originalClosesAt keeps the first one. */
  @IsOptional() @IsISO8601({ strict: true })
  closesAt?: string;

  /** Not below the questions' total (and equal to it while the test is published and has questions). */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_TEST_MARKS)
  maxMarks?: number;
}

/** GET /admin/tests */
export class ListTestsQueryDto extends PaginationQueryDto {
  /** One subject (Discipline id). */
  @IsOptional() @IsUUID()
  subjectId?: string;

  /** JUNIOR, MIDDLE, SENIOR or ALL (exact match). */
  @IsOptional() @IsIn(TEST_DIVISIONS)
  division?: (typeof TEST_DIVISIONS)[number];

  /** DRAFT or PUBLISHED. */
  @IsOptional() @IsIn(TEST_STATUSES)
  status?: (typeof TEST_STATUSES)[number];

  /** Part of the title (1–100 characters, case-insensitive). */
  @IsOptional() @IsString() @Transform(trim) @Length(1, 100)
  q?: string;
}

/** PATCH /admin/tests/:id/questions/:questionId */
export class UpdateTestQuestionDto {
  @IsOptional() @IsString() @Transform(trim) @Length(1, 5000)
  prompt?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_TEST_MARKS)
  maxMarks?: number;
}

/** PUT /admin/tests/:id/questions/order — every question id of the test, once, in the new order. */
export class ReorderTestQuestionsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_QUESTIONS) @ArrayUnique() @IsUUID('all', { each: true })
  questionIds: string[];
}

// ── Marker authorisations ─────────────────────────────────────────────────────

export const MARKER_STATES = ['active', 'revoked', 'all'] as const;

/** GET /admin/test-markers */
export class ListMarkersQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID()
  subjectId?: string;

  /** active (default), revoked or all. */
  @IsOptional() @IsIn(MARKER_STATES)
  state?: (typeof MARKER_STATES)[number];
}

/** GET /admin/test-markers/candidates */
export class MarkerCandidatesQueryDto extends PaginationQueryDto {
  /** The subject the coaches would mark. */
  @IsUUID()
  subjectId: string;

  /** Part of the first name, last name or username (1–100 characters). */
  @IsOptional() @IsString() @Transform(trim) @Length(1, 100)
  q?: string;
}

/** POST /admin/test-markers */
export class GrantMarkerDto {
  /** A Coach (MENTOR) account that is ACTIVE. */
  @IsUUID()
  coachId: string;

  @IsUUID()
  subjectId: string;

  /** Optional note (up to 500 characters). */
  @IsOptional() @IsString() @Transform(trim) @Length(1, 500)
  reason?: string;
}

/** POST /admin/test-markers/:id/revoke */
export class RevokeMarkerDto {
  /** Mandatory (3–500 characters). */
  @IsString() @Transform(trim) @Length(3, 500)
  reason: string;
}
