import {
  IsBoolean,
  IsEnum,
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
  @IsOptional() @IsEnum(AssignmentStatus) status?: AssignmentStatus;
  @IsOptional() @IsUUID() academicYearId?: string;
}
