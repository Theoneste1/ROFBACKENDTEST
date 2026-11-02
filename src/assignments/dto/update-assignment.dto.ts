import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { toBoolean } from './create-assignment.dto.js';

/** Course and division cannot change; create a new assignment instead. */
export class UpdateAssignmentDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  @Transform(({ value }: { value: string }) => value?.trim())
  title?: string;

  @IsOptional()
  @IsString()
  @Length(10, 10000)
  @Transform(({ value }: { value: string }) => value?.trim())
  instructions?: string;

  @IsOptional()
  @IsISO8601()
  deadline?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  @Type(() => Number)
  points?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  @Type(() => Number)
  maximumMarks?: number;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  allowResubmission?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  @Type(() => Number)
  maxResubmissions?: number;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  allowLateSubmission?: boolean;
}
