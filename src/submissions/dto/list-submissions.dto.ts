import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { SubmissionStatus } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';

export class ListSubmissionsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() assignmentId?: string;
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsUUID() mentorId?: string;
  @IsOptional() @IsUUID() studentId?: string;
  @IsOptional() @IsEnum(SubmissionStatus) status?: SubmissionStatus;
}

export const REVIEW_QUEUE_GROUPS = ['open', 'done', 'all'] as const;
export type ReviewQueueGroup = (typeof REVIEW_QUEUE_GROUPS)[number];
export const REVIEW_QUEUE_SORTS = ['submitted', 'recent', 'name', 'score'] as const;
export type ReviewQueueSort = (typeof REVIEW_QUEUE_SORTS)[number];

/**
 * GET /mentor/reviews — the coach's own reviews. All fields are optional and additive: without
 * them the queue is exactly what it was (the open reviews, oldest submission first). The backend
 * advertises them with the `reviewQueueFilters` capability (GET /api/v1).
 */
export class ReviewQueueQueryDto extends ListSubmissionsDto {
  /** Student first name, last name or username (contains, case-insensitive). */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 100)
  q?: string;

  /**
   * open: still with the coach (ASSIGNED, IN_REVIEW, MARKED, REJECTED, RESUBMISSION_REQUESTED);
   * done: the coach's part is finished (SUBMITTED_TO_ADMIN, APPROVED, PUBLISHED); all: every status.
   * Ignored when `status` is given.
   */
  @IsOptional() @IsIn(REVIEW_QUEUE_GROUPS) group?: ReviewQueueGroup;

  /** submitted: oldest first (default) · recent: newest first · name: student A–Z · score: highest first. */
  @IsOptional() @IsIn(REVIEW_QUEUE_SORTS) sort?: ReviewQueueSort;
}
