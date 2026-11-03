import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { IntersectionType } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/pagination.js';
import { trim } from '../../auth/dto/password.rules.js';
import { AssignmentStatus } from '../../generated/prisma/client.js';

/**
 * Account status of a user, derived from the account flags:
 *   ACTIVE          — activated and not suspended;
 *   INACTIVE        — suspended (isActive = false);
 *   AWAITING_SETUP  — invited/created but the account was never activated.
 */
export const USER_STATUSES = ['ACTIVE', 'INACTIVE', 'AWAITING_SETUP'] as const;
export type UserStatusFilter = (typeof USER_STATUSES)[number];

/**
 * Filters shared by the dashboard and every report.
 *
 * academicYearId — defaults to the current academic year; `all` for every year.
 * from / to      — ISO 8601; a plain date (YYYY-MM-DD) covers that whole day in
 *                  the programme time zone. Applies to when things happened
 *                  (registered, published, submitted, reviewed, reported).
 */
export class ReportFiltersDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  academicYearId?: string;

  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsUUID() courseId?: string;

  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

/** Report lists: filters plus pagination (CSV exports ignore page/limit). */
export class ReportListDto extends IntersectionType(ReportFiltersDto, PaginationQueryDto) {}

/** Student and mentor lists: also filter by account status and search. */
export class UserReportDto extends ReportListDto {
  @IsOptional()
  @IsIn(USER_STATUSES, { message: `status must be one of: ${USER_STATUSES.join(', ')}` })
  status?: UserStatusFilter;

  /** Name, username or e-mail contains. */
  @IsOptional() @IsString() @Length(1, 100) @Transform(trim) q?: string;
}

/** Assignment submission report: optionally only some assignment statuses. */
export class AssignmentReportDto extends ReportListDto {
  @IsOptional() @IsEnum(AssignmentStatus) status?: AssignmentStatus;
}
