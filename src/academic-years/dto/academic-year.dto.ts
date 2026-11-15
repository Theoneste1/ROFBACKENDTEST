import { IsBoolean, IsEnum, IsISO8601, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { GradeLevel, StudentEnrollmentStatus } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { trim } from '../../auth/dto/password.rules.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAcademicYearDto {
  /** e.g. "2027-2028". */
  @IsString()
  @Length(4, 30)
  @Transform(trim)
  name: string;

  /** First day (YYYY-MM-DD). */
  @IsISO8601()
  @Matches(DATE_ONLY, { message: 'startsOn must be a date (YYYY-MM-DD).' })
  startsOn: string;

  /** Last day (YYYY-MM-DD). */
  @IsISO8601()
  @Matches(DATE_ONLY, { message: 'endsOn must be a date (YYYY-MM-DD).' })
  endsOn: string;
}

export class UpdateAcademicYearDto {
  @IsOptional() @IsString() @Length(4, 30) @Transform(trim)
  name?: string;

  @IsOptional() @IsISO8601() @Matches(DATE_ONLY)
  startsOn?: string;

  @IsOptional() @IsISO8601() @Matches(DATE_ONLY)
  endsOn?: string;
}

export class ActivateAcademicYearDto {
  /** Move every active student up one grade (true at the start of a new school year). */
  @IsBoolean()
  promoteStudents: boolean;

  /** When promoting, deactivate S6 students who graduate (default true). */
  @IsOptional()
  @IsBoolean()
  deactivateGraduates?: boolean;

  /**
   * REQUIRED: the academic year the caller saw as current (null: none). When the current year is
   * now another one (another start went through meanwhile), the start is refused with
   * 409 CURRENT_YEAR_CHANGED instead of closing a year the caller never saw and rolling students
   * over a second time. Required so that no client can start a year blind.
   */
  @ValidateIf((o) => o.expectedCurrentYearId !== null)
  @IsUUID('all', { message: 'expectedCurrentYearId must be the id of the current academic year, or null when there is none.' })
  expectedCurrentYearId: string | null;
}

export class ListEnrollmentsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsEnum(GradeLevel) gradeLevel?: GradeLevel;
  @IsOptional() @IsEnum(StudentEnrollmentStatus) status?: StudentEnrollmentStatus;
  @IsOptional() @IsUUID() schoolId?: string;
}

export class UpdateEnrollmentDto {
  /** Correct the student's grade in the current year (moves division if needed). */
  @IsOptional()
  @IsEnum(GradeLevel)
  gradeLevel?: GradeLevel;

  /** WITHDRAWN ends the enrolment and suspends the account. */
  @IsOptional()
  @IsEnum(['WITHDRAWN'], { message: 'status can only be set to WITHDRAWN.' })
  status?: 'WITHDRAWN';
}
