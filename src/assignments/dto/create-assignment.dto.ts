import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { AssignmentStatus } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';

/** multipart/form-data sends booleans as strings. */
export const toBoolean = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

export class CreateAssignmentDto {
  @IsString()
  @Length(3, 200)
  @Transform(({ value }: { value: string }) => value?.trim())
  title: string;

  /** One of the four courses. */
  @IsUUID()
  courseId: string;

  /** Junior or Senior — the mentor must be assigned to this course × division. */
  @IsUUID()
  divisionId: string;

  /** Short summary shown in lists (the full brief goes in instructions). */
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @Transform(({ value }: { value: string }) => value?.trim())
  description?: string;

  @IsString()
  @Length(10, 10000)
  @Transform(({ value }: { value: string }) => value?.trim())
  instructions: string;

  /** ISO-8601 datetime for the submission deadline. */
  @IsISO8601()
  deadline: string;

  /** Leaderboard points available; awarded in proportion to the score. */
  @IsInt()
  @Min(0)
  @Max(10000)
  @Type(() => Number)
  points: number;

  /** Ceiling for mentor scores. All submitted scores are validated against this. */
  @IsInt()
  @Min(1)
  @Max(10000)
  @Type(() => Number)
  maximumMarks: number;

  /** Whether students may resubmit before the deadline (while not yet under review). */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  allowResubmission?: boolean;

  /** Maximum resubmissions (0 = unlimited). Requires allowResubmission. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  @Type(() => Number)
  maxResubmissions?: number;

  /** Accept first submissions after the deadline (flagged as late). */
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  allowLateSubmission?: boolean;
}

export class ListAssignmentsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() courseId?: string;
  /** Mentors/admins only. */
  @IsOptional() @IsUUID() divisionId?: string;
  /** Mentors/admins only. */
  /** Students: PUBLISHED or CLOSED only. */
  @IsOptional() @IsEnum(AssignmentStatus) status?: AssignmentStatus;
  /**
   * Several statuses at once (comma-separated, e.g. DRAFT,REJECTED), so a list that groups
   * statuses pages in the database. Not together with `status`.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value))
  @IsEnum(AssignmentStatus, { each: true })
  statuses?: AssignmentStatus[];
  @IsOptional() @IsUUID() academicYearId?: string;
  /** Mentors/admins only: assignments prepared by this mentor. */
  @IsOptional() @IsUUID() createdById?: string;
  /** Search title, description and instructions. */
  @IsOptional() @IsString() @Length(1, 100)
  @Transform(({ value }: { value: string }) => value?.trim())
  q?: string;
  /** Deadline on or after this instant. */
  @IsOptional() @IsISO8601() deadlineFrom?: string;
  /** Deadline on or before this instant. */
  @IsOptional() @IsISO8601() deadlineTo?: string;
}

/**
 * The student's progress on an assignment, as shown in My Assignments. The labels match
 * `displayStatus` (NOT_STARTED = "Not Started", …); OVERDUE = not started and no longer
 * submittable (closed, or past the deadline without late work).
 */
export const MY_ASSIGNMENT_PROGRESS = ['NOT_STARTED', 'SUBMITTED', 'PENDING_REVIEW', 'RESUBMISSION_REQUESTED', 'REVIEWED', 'OVERDUE'] as const;
export type MyAssignmentProgress = (typeof MY_ASSIGNMENT_PROGRESS)[number];
export const MY_ASSIGNMENT_SORTS = ['deadline', '-deadline', 'title'] as const;

/** GET /me/assignments: the list filters plus the student's progress and a sort, applied in the database. */
export class MyAssignmentsQueryDto extends ListAssignmentsDto {
  /** Only assignments where my progress is this (paging and totals count the matches). */
  @IsOptional() @IsIn(MY_ASSIGNMENT_PROGRESS) progress?: MyAssignmentProgress;
  /** deadline (soonest first, the default), -deadline (latest first) or title (A–Z). */
  @IsOptional() @IsIn(MY_ASSIGNMENT_SORTS) sort?: (typeof MY_ASSIGNMENT_SORTS)[number];
}
