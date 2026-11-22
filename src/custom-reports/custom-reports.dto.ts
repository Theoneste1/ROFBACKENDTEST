import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min, ValidateNested,
} from 'class-validator';

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
}

/** One grant: a user OR a role, and its levels (view, download, edit; all three = full access). */
export class ReportGrantDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
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
  @IsIn(['csv', 'xlsx']) format: 'csv' | 'xlsx';
}
