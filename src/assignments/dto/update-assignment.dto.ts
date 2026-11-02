import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class UpdateAssignmentDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  @Transform(({ value }: { value: string }) => value?.trim())
  title?: string;

  @IsOptional()
  @IsString()
  @Length(10, 5000)
  @Transform(({ value }: { value: string }) => value?.trim())
  instructions?: string;

  @IsOptional()
  @IsISO8601()
  deadline?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  points?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  maximumMarks?: number;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }: { value: unknown }) => value === 'true' || value === true)
  allowResubmission?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  maxResubmissions?: number;
}
