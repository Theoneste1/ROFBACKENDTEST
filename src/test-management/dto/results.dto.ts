import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { MIN_OVERRIDE_REASON } from '../results-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => (value === 'true' || value === true ? true : value === 'false' || value === false ? false : value);

export const RANKING_GROUPS = ['overall', 'division', 'school'] as const;
export const RANKING_DIVISIONS = ['JUNIOR', 'MIDDLE', 'SENIOR', 'UNKNOWN'] as const;
export const EXPORT_TYPES = ['results', 'schools', 'divisions', 'questions'] as const;

// ── Publication (tests.publishResults; override: tests.overridePublication) ────────

/** POST /admin/tests/:id/results/publish */
export class PublishTestResultsDto {
  /** Optional idempotency key: the same key again returns the same publication (nothing published or sent twice). */
  @IsOptional() @IsUUID()
  clientKey?: string;
}

/** POST /admin/tests/:id/results/publish/override — Administrators only (a Head Coach can never override). */
export class OverridePublicationDto {
  /** Mandatory (10–1,000 characters): why results are published while some are not approved. Audited. */
  @IsString() @Transform(trim) @Length(MIN_OVERRIDE_REASON, 1000)
  reason: string;

  @IsOptional() @IsUUID()
  clientKey?: string;
}

/** GET /admin/tests/:id/results/preview — pages of the unapproved list. */
export class PublicationPreviewQueryDto extends PaginationQueryDto {}

/** GET /admin/tests/:id/results/publications */
export class PublicationsQueryDto extends PaginationQueryDto {}

// ── Results, rankings, reports (tests.viewResults, tests.viewRankings) ─────────────

/** GET /admin/tests/:id/results */
export class ListTestResultsQueryDto extends PaginationQueryDto {
  /** true: published results only; false: approved, not yet published. Default: both (every final, approved result). */
  @IsOptional() @Transform(bool) @IsBoolean()
  published?: boolean;

  @IsOptional() @IsUUID()
  schoolId?: string;

  @IsOptional() @IsIn(RANKING_DIVISIONS)
  division?: (typeof RANKING_DIVISIONS)[number];

  /** Student name, username or submission code. */
  @IsOptional() @IsString() @Transform(trim) @MaxLength(100)
  q?: string;
}

/** GET /admin/tests/:id/results/rankings */
export class RankingsQueryDto extends PaginationQueryDto {
  /** overall (default), by division or by school. */
  @IsOptional() @IsIn(RANKING_GROUPS)
  by?: (typeof RANKING_GROUPS)[number];

  /** Only this division (by=division). */
  @IsOptional() @IsIn(RANKING_DIVISIONS)
  division?: (typeof RANKING_DIVISIONS)[number];

  /** Only this school (by=school). */
  @IsOptional() @IsUUID()
  schoolId?: string;

  /** true: rank the published results only. Default: every approved final result (published or not). */
  @IsOptional() @Transform(bool) @IsBoolean()
  published?: boolean;
}

/** GET /admin/tests/:id/results/report */
export class ResultsReportQueryDto {
  /** true: the published results only. Default: every approved final result. */
  @IsOptional() @Transform(bool) @IsBoolean()
  published?: boolean;
}

/** GET /admin/tests/:id/results/export.csv */
export class ResultsExportQueryDto extends ResultsReportQueryDto {
  /** results (default: one row per result, with marks per question), schools, divisions or questions. */
  @IsOptional() @IsIn(EXPORT_TYPES)
  type?: (typeof EXPORT_TYPES)[number];
}

/** GET /admin/test-reports */
export class TestReportsQueryDto extends PaginationQueryDto {
  @IsOptional() @IsUUID()
  subjectId?: string;

  /** Title contains. */
  @IsOptional() @IsString() @Transform(trim) @MaxLength(100)
  q?: string;
}

// ── Students and teachers ───────────────────────────────────────────────────────

/** GET /me/test-results, GET /teacher/test-results */
export class MyResultsQueryDto extends PaginationQueryDto {}

/** GET /teacher/test-results/:testId */
export class SchoolResultsQueryDto extends PaginationQueryDto {
  /** One of the teacher's schools. */
  @IsOptional() @IsUUID()
  schoolId?: string;

  /** Student name or username. */
  @IsOptional() @IsString() @Transform(trim) @MaxLength(100)
  q?: string;
}

