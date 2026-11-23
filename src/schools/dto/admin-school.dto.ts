import { Transform } from 'class-transformer';
import {
  IsBoolean, IsEnum, IsIn, IsISO31661Alpha2, IsOptional, IsString, IsUUID, Length, Matches, ValidateIf,
} from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { ProgrammeCategory, SchoolAccommodation, SchoolSource } from '../../generated/prisma/client.js';
import { cleanSchoolName, SCHOOL_OWNERSHIP } from '../school-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const cleanName = ({ value }: { value: unknown }) => (typeof value === 'string' ? cleanSchoolName(value) : value);
const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);
/** GET /admin/schools sort keys. */
export const SCHOOL_LIST_SORTS = ['name', 'verifiedStudents'] as const;
/** Free-text directory places (cell, village): trimmed, inner whitespace collapsed; null clears. */
const place = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);
/** No control characters (names and places are shown everywhere and exported to CSV). */
export const PRINTABLE = /^\P{Cc}+$/u;

/** GET /admin/schools — every school (official, Administrator-created and legacy; active or not). */
export class ListAdminSchoolsDto extends PaginationQueryDto {
  /** Name (contains) or code (starts with). */
  @IsOptional() @IsString() @Length(1, 100) @Transform(trim) q?: string;
  @IsOptional() @Transform(upper) @IsISO31661Alpha2() countryCode?: string;
  @IsOptional() @IsString() @Length(1, 100) province?: string;
  @IsOptional() @IsString() @Length(1, 100) district?: string;
  @IsOptional() @IsString() @Length(1, 100) sector?: string;
  /** Cell / village (any letter case). */
  @IsOptional() @IsString() @Length(1, 100) @Transform(place) cell?: string;
  @IsOptional() @IsString() @Length(1, 100) @Transform(place) village?: string;
  /** PUBLIC, GOVERNMENT_AIDED or PRIVATE. */
  @IsOptional() @Transform(upper) @IsIn(SCHOOL_OWNERSHIP) ownership?: (typeof SCHOOL_OWNERSHIP)[number];
  /** An active contact (e-mail or phone) containing this text (any letter case; spaces ignored for phones). */
  @IsOptional() @IsString() @Length(3, 100) @Transform(trim) contact?: string;
  /** true: has an active e-mail contact; false: has none. */
  @IsOptional() @Transform(bool) @IsBoolean() hasEmail?: boolean;
  /** true: has an active phone contact; false: has none. */
  @IsOptional() @Transform(bool) @IsBoolean() hasPhone?: boolean;
  @IsOptional() @Transform(bool) @IsBoolean() isActive?: boolean;
  @IsOptional() @IsEnum(SchoolSource) source?: SchoolSource;
  /** Offers this education level (e.g. PR, OL, AL). */
  @IsOptional() @Transform(upper) @IsString() @Length(1, 10) level?: string;
  /** Offers this programme (its id). */
  @IsOptional() @IsUUID() programme?: string;
  /** Offers a programme of this category (A-Level combination, TVET trade, other). */
  @IsOptional() @IsEnum(ProgrammeCategory) programmeCategory?: ProgrammeCategory;
  @IsOptional() @IsEnum(SchoolAccommodation) accommodation?: SchoolAccommodation;
  /** false: schools without an official code. */
  @IsOptional() @Transform(bool) @IsBoolean() hasCode?: boolean;
  /** true: schools whose source records report data problems. */
  @IsOptional() @Transform(bool) @IsBoolean() hasSourceIssues?: boolean;
  /**
   * Sort (schools table, 2026-11-19): `name` (default) or `verifiedStudents` — the number of students whose CURRENT
   * school claim an Administrator verified. Ties: name, then id.
   */
  @IsOptional() @IsIn(SCHOOL_LIST_SORTS) sort?: (typeof SCHOOL_LIST_SORTS)[number];
  /** asc (default) or desc. */
  @IsOptional() @IsIn(['asc', 'desc']) order?: 'asc' | 'desc';
}

/**
 * POST /admin/schools. Rwanda (default country): province, district and sector from the official
 * directory; an optional official 6-digit code whose first digit is the province. Another country
 * (ISO 3166-1 alpha-2): a location, and never a code or a Rwandan province / district / sector.
 */
export class CreateSchoolDto {
  @Transform(cleanName)
  @IsString()
  @Length(2, 200)
  @Matches(PRINTABLE, { message: 'name must not contain control characters.' })
  name: string;

  /** ISO 3166-1 alpha-2; default RW. */
  @IsOptional()
  @Transform(upper)
  @IsISO31661Alpha2({ message: 'countryCode must be an ISO 3166-1 alpha-2 country code (e.g. RW, KE).' })
  countryCode?: string;

  /** Rwanda only: the official code (6 digits; first digit = province). */
  @IsOptional()
  @Transform(trim)
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits.' })
  code?: string;

  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) province?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) district?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) sector?: string;

  /** Required outside Rwanda; in Rwanda defaults to "Sector, District". */
  @IsOptional() @Transform(trim) @IsString() @Length(2, 200) @Matches(PRINTABLE) location?: string;

  @IsOptional() @IsIn(SCHOOL_OWNERSHIP) ownership?: (typeof SCHOOL_OWNERSHIP)[number];

  /** Rwanda only: the cell and village (free text, as in the official directory). */
  @IsOptional() @Transform(place) @IsString() @Length(1, 100) @Matches(PRINTABLE) cell?: string;
  @IsOptional() @Transform(place) @IsString() @Length(1, 100) @Matches(PRINTABLE) village?: string;

  @IsOptional() @IsEnum(SchoolAccommodation) accommodation?: SchoolAccommodation;

  /** Create even though schools with the same normalised name exist nearby (recorded in the audit log). */
  @IsOptional() @IsBoolean() confirmPossibleDuplicate?: boolean;
}

/**
 * PATCH /admin/schools/:id. The id never changes, so students, claims (and their verification
 * status), enrolments and Teacher assignments are unaffected. `reason` is required to set or
 * change a code, and to change the name, country or place of an official-directory school.
 */
export class UpdateSchoolDto {
  @IsOptional()
  @Transform(cleanName)
  @IsString()
  @Length(2, 200)
  @Matches(PRINTABLE, { message: 'name must not contain control characters.' })
  name?: string;

  @IsOptional()
  @Transform(upper)
  @IsISO31661Alpha2({ message: 'countryCode must be an ISO 3166-1 alpha-2 country code (e.g. RW, KE).' })
  countryCode?: string;

  /** Set or change the official code (it cannot be removed). */
  @ValidateIf((o) => o.code !== undefined)
  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be exactly 6 digits.' })
  code?: string;

  /** null clears (only when the school is moved outside Rwanda). */
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) province?: string | null;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) district?: string | null;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) sector?: string | null;

  @IsOptional() @Transform(trim) @IsString() @Length(2, 200) @Matches(PRINTABLE) location?: string;

  @IsOptional() @IsIn(SCHOOL_OWNERSHIP) ownership?: (typeof SCHOOL_OWNERSHIP)[number];

  /** null clears. */
  @IsOptional() @Transform(place) @IsString() @Length(1, 100) @Matches(PRINTABLE) cell?: string | null;
  @IsOptional() @Transform(place) @IsString() @Length(1, 100) @Matches(PRINTABLE) village?: string | null;
  @IsOptional() @IsEnum(SchoolAccommodation) accommodation?: SchoolAccommodation | null;

  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) reason?: string;

  @IsOptional() @IsBoolean() confirmPossibleDuplicate?: boolean;
}

/** PATCH /admin/schools/:id/active */
/** POST /admin/schools/:id/verify: an optional note for the audit log. */
export class VerifySchoolDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class SetSchoolActiveDto {
  @IsBoolean()
  isActive: boolean;

  /** Why (recorded in the audit log). */
  @Transform(trim)
  @IsString()
  @Length(3, 500)
  reason: string;
}
