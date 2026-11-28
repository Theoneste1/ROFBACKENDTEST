import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsISO8601, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested } from 'class-validator';

import { Role } from '../generated/prisma/client.js';
import { FILTER_OPS, type FilterOp } from './report-sources.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class ReportFilterDto {
  @IsString() @Length(1, 50) field: string;
  @IsIn(FILTER_OPS as unknown as string[]) op: FilterOp;
  /** Text, a date (ISO), true / false, or a list of values (for "in"). */
  @IsOptional() value?: unknown;
}

export class ReportSortDto {
  @IsString() @Length(1, 50) field: string;
  @IsIn(['asc', 'desc']) dir: 'asc' | 'desc';
}

/** The definition of a report (preview) — source, columns in order, filters, sort. */
export class ReportDefinitionDto {
  @IsString() @Length(1, 30) source: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(40) @IsString({ each: true }) columns: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => ReportFilterDto) filters?: ReportFilterDto[];
  @IsOptional() @IsArray() @ArrayMaxSize(5) @ValidateNested({ each: true }) @Type(() => ReportSortDto) sort?: ReportSortDto[];
}

/** POST /reports, PUT /reports/:id — a named, described definition. */
export class SaveReportDto extends ReportDefinitionDto {
  @Transform(trim) @IsString() @Length(2, 120) name: string;
  @IsOptional() @Transform(trim) @IsString() @Length(0, 1000) description?: string;
  /** Save as a template every Administrator may start from (the Super Admin only; 403 REPORT_TEMPLATE_SUPER_ADMIN_ONLY). */
  @IsOptional() @IsBoolean() isTemplate?: boolean;
}

/** One grant: a user, a role OR a school (its teachers), its levels (view, download, edit), and an optional expiry. */
export class ReportGrantDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  /** A school: its teachers with an active assignment (owner 2026-11-28). */
  @IsOptional() @IsUUID() schoolId?: string;
  /** After this moment the grant gives nothing (ISO 8601, in the future); absent or null: no expiry. */
  @IsOptional() @IsISO8601() expiresAt?: string | null;
  @IsBoolean() canView: boolean;
  @IsBoolean() canDownload: boolean;
  @IsBoolean() canEdit: boolean;
}

export class SetReportGrantsDto {
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => ReportGrantDto) grants: ReportGrantDto[];
}

export class ReportPageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class ReportExportQueryDto {
  @IsIn(['csv', 'xlsx', 'pdf']) format: 'csv' | 'xlsx' | 'pdf';
}
