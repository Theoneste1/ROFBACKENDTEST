import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min, ValidateNested,
} from 'class-validator';

import { CATEGORY_KEYS } from './field-policy.js';
import type { FilterGroup } from './query-compiler.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class RegistrationSortDto {
  /** A field key from GET /admin/registration-data/fields, e.g. "user.lastName". */
  @IsString() @Length(1, 120) field: string;
  @IsIn(['asc', 'desc']) dir: 'asc' | 'desc';
}

/**
 * A query: the category, the columns in order, the filter, the sort and the search box.
 *
 * `filter`: a group { combinator: "AND" | "OR", conditions: [...] } whose conditions are { field, operator, value?,
 * value2? } or further groups (at most 4 levels, 50 conditions). Operators by field type: text contains, notContains,
 * eq, neq, startsWith; number eq, neq, gt, gte, lt, lte, between (value, value2); date and date-time on, before, after,
 * between (YYYY-MM-DD, days in Kigali time); yes / no isTrue, isFalse; choice in, notIn (a list); lists hasAny,
 * hasAll, hasNone; every type isEmpty, isNotEmpty. Checked against the catalogue: 400 INVALID_QUERY lists the problems.
 */
export class RegistrationQueryDto {
  @IsIn(CATEGORY_KEYS) category: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(150) @IsString({ each: true }) columns: string[];
  @IsOptional() @IsObject() filter?: FilterGroup;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => RegistrationSortDto) sort?: RegistrationSortDto[];
  @IsOptional() @Transform(trim) @IsString() @Length(0, 100) search?: string;
}

export class RegistrationPageQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
}

export class RegistrationExportQueryDto {
  @IsIn(['csv', 'xlsx']) format: 'csv' | 'xlsx';
}

export class RegistrationFieldsQueryDto {
  @IsIn(CATEGORY_KEYS) category: string;
}

export class RegistrationCategoryQueryDto {
  @IsOptional() @IsIn(CATEGORY_KEYS) category?: string;
}

/**
 * PATCH /admin/registration-data/users/:id. `changes`: { "<field key>": value } — only fields the record lists as
 * editable. `version`: the record's version as read (409 RECORD_CHANGED if it changed since). `currentPassword`: your own
 * password, needed only to change a role to or from Administrator or Super Administrator.
 */
export class UpdateRegistrationRecordDto {
  @IsObject() changes: Record<string, unknown>;
  @IsOptional() @IsString() @Length(1, 40) version?: string;
  @IsOptional() @IsString() @Length(1, 200) currentPassword?: string;
}

export class SaveRegistrationFilterDto {
  @Transform(trim) @IsString() @Length(2, 120) name: string;
  @IsIn(CATEGORY_KEYS) category: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(150) @IsString({ each: true }) columns: string[];
  @IsObject() filter: FilterGroup;
  @IsOptional() @IsArray() @ArrayMaxSize(3) @ValidateNested({ each: true }) @Type(() => RegistrationSortDto) sort?: RegistrationSortDto[];
  @IsOptional() @IsBoolean() shared?: boolean;
}

export class SaveRegistrationLayoutDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(150) @IsString({ each: true }) columns: string[];
}
