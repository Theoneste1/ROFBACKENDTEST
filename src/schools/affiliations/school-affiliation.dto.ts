import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsISO31661Alpha2, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { SchoolAffiliationStatus } from '../../generated/prisma/client.js';
import { cleanSchoolName } from '../school-rules.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** GET /admin/school-affiliations */
export class ListAffiliationsDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(SchoolAffiliationStatus) status?: SchoolAffiliationStatus;
  @IsOptional() @IsUUID() schoolId?: string;
  @IsOptional() @IsUUID() studentId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2()
  country?: string;

  /** Whether the claim is linked to a school (false: the queue of name-only claims to match). Independent of status. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  hasSchool?: boolean;

  /** Current claims only (default true); false includes superseded history. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  current?: boolean;
}

/** POST …/verify — an optional internal note. */
export class VerifyAffiliationDto {
  @IsOptional()
  @IsString()
  @Length(3, 500)
  @Transform(trim)
  note?: string;
}

/** POST …/reject and …/revoke — the reason is required and shown to the student. */
export class AffiliationReasonDto {
  @IsString()
  @Length(3, 500)
  @Transform(trim)
  reason: string;
}

/** No control characters (the name is shown to Administrators and exported). */
const PRINTABLE = /^\P{Cc}+$/u;

/**
 * POST /me/school-affiliation — exactly one of (rules in school-claim-rules.ts):
 *   { schoolCode }                                                      a Rwandan school by its official code
 *   { schoolName, schoolProvince, schoolDistrict, schoolSector }        Rwanda, "my school is not listed"
 *   { country, schoolName }                                             another country (ISO 3166-1 alpha-2)
 */
export class StudentClaimDto {
  @IsOptional()
  @Transform(trim)
  @Matches(/^\d{6}$/, { message: 'schoolCode must be the 6-digit official school code.' })
  schoolCode?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? cleanSchoolName(value) : value))
  @IsString()
  @Length(2, 200)
  @Matches(PRINTABLE, { message: 'schoolName must not contain control characters.' })
  schoolName?: string;

  /** Default RW. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2({ message: 'country must be an ISO 3166-1 alpha-2 code (e.g. RW, KE).' })
  country?: string;

  /** Rwanda, "not listed": the school's place in the official directory (all three together). */
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) schoolProvince?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) schoolDistrict?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) schoolSector?: string;
}

/** POST …/:id/match — link a name-only claim to an existing school (it stays PENDING). */
export class MatchAffiliationDto {
  @IsUUID()
  schoolId: string;

  @IsOptional()
  @IsString()
  @Length(3, 500)
  @Transform(trim)
  note?: string;

  /** Required when the school's province, district or sector differs from what the student entered. */
  @IsOptional()
  @IsBoolean()
  confirmDifferentPlace?: boolean;
}
