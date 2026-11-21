import { ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { trim } from '../../auth/dto/password.rules.js';
import { GradeLevel } from '../../generated/prisma/client.js';

const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** PATCH /admin/divisions/:id — every field optional; the code never changes. */
export class UpdateDivisionDto {
  @IsOptional()
  @IsString()
  @Length(2, 100)
  @Transform(trim)
  name?: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  @Transform(trim)
  description?: string;

  /** false: offered for no new student, test or course (refused while students are in it or a test is open). */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** The grades this division is suggested for (every grade S1–S6 must stay with exactly one active division). */
  @IsOptional()
  @IsArray() @ArrayMaxSize(6) @IsEnum(GradeLevel, { each: true })
  suggestedGrades?: GradeLevel[];

  /** Display order (lower first). */
  @IsOptional()
  @IsInt() @Min(0) @Max(1000)
  sortOrder?: number;
}

/** POST /admin/divisions — a new division (e.g. ADVANCED). */
export class CreateDivisionDto {
  /** Permanent code: 2–30 capitals, digits or underscores, starting with a letter; never ALL. */
  @Transform(upper)
  @Matches(/^(?!ALL$)[A-Z][A-Z0-9_]{1,29}$/, { message: 'code must be 2–30 capitals, digits or underscores, starting with a letter (not ALL).' })
  code: string;

  @IsString()
  @Length(2, 100)
  @Transform(trim)
  name: string;

  @IsOptional()
  @IsString()
  @Length(0, 1000)
  @Transform(trim)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray() @ArrayMaxSize(6) @IsEnum(GradeLevel, { each: true })
  suggestedGrades?: GradeLevel[];

  @IsOptional()
  @IsInt() @Min(0) @Max(1000)
  sortOrder?: number;
}
