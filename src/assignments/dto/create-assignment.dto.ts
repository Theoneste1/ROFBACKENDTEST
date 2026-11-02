import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class CreateAssignmentDto {
  @IsString()
  @Length(3, 200)
  @Transform(({ value }: { value: string }) => value?.trim())
  title: string;

  /** The published course this assignment belongs to. */
  @IsUUID()
  courseId: string;

  @IsString()
  @Length(10, 5000)
  @Transform(({ value }: { value: string }) => value?.trim())
  instructions: string;

  /** ISO-8601 datetime string for the submission deadline. */
  @IsISO8601()
  deadline: string;

  /** Points awarded on the leaderboard when the result is published. */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  points: number;

  /** Ceiling for mentor scores. All submitted scores are validated against this. */
  @IsInt()
  @Min(1)
  @Type(() => Number)
  maximumMarks: number;

  /** Whether students may resubmit before the deadline. Defaults to false. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  allowResubmission?: boolean;

  /**
   * Maximum number of resubmissions allowed (0 = unlimited while deadline not passed).
   * Ignored when allowResubmission is false.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  maxResubmissions?: number;
}
