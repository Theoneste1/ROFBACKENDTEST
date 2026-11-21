import {
 
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Gender, GradeLevel, OlympiadLevel, OlympiadSubject, Role, AccountStatus } from '../../generated/prisma/client.js';
import { IsStrongPassword, lower, trim } from '../../auth/dto/password.rules.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { HomePlacePart } from '../../common/home-place.js';
import { IsStudentDateOfBirth } from '../../auth/dto/registration-details.rules.js';
import { IsOtherInterest, NonEmptyUnlessOther } from '../olympiad-interests.rules.js';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  @Matches(/^[a-z0-9._-]+$/, { message: 'Username may contain letters, digits, ".", "_" and "-" only.' })
  @Transform(lower)
  username?: string;

  @IsOptional()
  @IsEmail()
  @Transform(lower)
  email?: string;

  @IsOptional()
  @IsStrongPassword()
  password?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /**
   * Your own current password (step-up, P1-08). Required to change a role to or
   * from ADMIN or SUPER_ADMIN; otherwise ignored. Never stored or logged.
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  currentPassword?: string;

  /** Changing the grade moves a student to the matching division. */
  @IsOptional()
  @IsEnum(GradeLevel)
  gradeLevel?: GradeLevel;

  /**
   * Omitted: the school is kept. A school id: the student moves to that school. null: the
   * student's school is cleared (their current school claim ends; no new claim is created).
   */
  @IsOptional()
  @IsUUID()
  schoolId?: string | null;

  /**
   * A Rwandan school by its official code — an alternative to schoolId (PR B). Given together,
   * both must name the same school.
   */
  @ValidateIf((o) => o.schoolCode !== undefined)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'schoolCode must be exactly 6 digits.' })
  schoolCode?: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  @Transform(trim)
  homeLocation?: string;

  /**
   * Home location (homeLocationRules; owner, 2026-11-20): the home country (ISO 3166-1 alpha-2, stored in `country`);
   * with Rwanda the home province, district and sector are required (a place of the official directory, else 400
   * UNKNOWN_HOME_LOCATION); with another country they are not asked and the stored ones are cleared (sent anyway:
   * 400 HOME_LOCATION_RWANDA_ONLY). The place is only accepted together with homeCountry (400 HOME_COUNTRY_REQUIRED).
   * Separate from the school location.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2({ message: 'homeCountry must be an ISO 3166-1 alpha-2 code (e.g. RW).' })
  homeCountry?: string;

  @HomePlacePart('homeCountry')
  @IsString() @Length(1, 100) @Transform(trim)
  homeProvince?: string;

  @HomePlacePart('homeCountry')
  @IsString() @Length(1, 100) @Transform(trim)
  homeDistrict?: string;

  @HomePlacePart('homeCountry')
  @IsString() @Length(1, 100) @Transform(trim)
  homeSector?: string;

  /** Correct the account's gender (FEMALE or MALE; capability genderStep). Not audited with its value. */
  @IsOptional()
  @IsEnum(Gender, { message: 'gender must be FEMALE or MALE.' })
  gender?: Gender;

  /**
   * A Coach's Olympiad subject interests (capability coachOlympiadInterests), replacing the stored ones: one or more of
   * MATHEMATICS, COMPUTING and PHYSICS, no duplicates. Coach (MENTOR) accounts only (400 INTERESTS_COACH_ONLY); the
   * route already needs users.manage and the right to manage the account's role (users.manageCoaches). Information only:
   * interests never grant marking or any other permission.
   */
  @IsOptional()
  @IsArray()
  @NonEmptyUnlessOther()
  @ArrayUnique({ message: 'olympiadInterests must not name a subject twice.' })
  @IsEnum(OlympiadSubject, { each: true, message: 'olympiadInterests must contain only MATHEMATICS, COMPUTING or PHYSICS.' })
  olympiadInterests?: OlympiadSubject[];

  /**
   * Another Olympiad named in words ("Other"; owner 2026-11-21; capability olympiadInterestOther), 2–100 characters,
   * e.g. "Chemistry". With it, olympiadInterests may be empty. null clears it (only beside at least one subject).
   * Never a subject: grants nothing, not part of Test Management.
   */
  @ValidateIf((o: { olympiadInterestOther?: unknown }) => o.olympiadInterestOther !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOtherInterest()
  olympiadInterestOther?: string | null;
}

export class UpdateUserStatusDto {
  /**
   * Compatible with the account states (capability accountStates): false suspends the account immediately (SUSPENDED;
   * all sessions are revoked), true lifts a suspension or reactivates a deactivated account (an archived account is
   * restored with POST /admin/users/:id/status-changes only). Prefer that route: it records your reason.
   */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Approve a student or mentor waiting for approval. */
  @IsOptional()
  @IsBoolean()
  isApproved?: boolean;
}

/** POST /admin/users/:id/status-changes (capability accountStates). */
export class ChangeAccountStatusDto {
  @IsEnum(AccountStatus, { message: 'toStatus must be one of ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED.' })
  toStatus: AccountStatus;

  /** Required (3–500 characters) to deactivate, suspend or archive, and to restore an archived account. */
  @IsOptional()
  @IsString()
  @Length(0, 500)
  reason?: string;

  /** Must be true to restore an archived account (ARCHIVED → ACTIVE); ignored otherwise. */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

/** PUT /me/date-of-birth: "YYYY-MM-DD", the registration rules (a real past date, age 5–30 in Rwanda). */
/** PUT /me/gender (capability genderStep). */
export class SetGenderDto {
  @IsEnum(Gender, { message: 'gender must be FEMALE or MALE.' })
  gender: Gender;
}

export class SetDateOfBirthDto {
  @Transform(trim)
  @IsStudentDateOfBirth()
  dateOfBirth: string;
}

/**
 * PUT /admin/users/:id/date-of-birth (owner approval 2026-11-18): an Administrator corrects a student's date of birth.
 * The registration rules apply; a reason is mandatory (5–500 characters) and is recorded with the old and new values.
 */
export class CorrectDateOfBirthDto {
  @Transform(trim)
  @IsStudentDateOfBirth()
  dateOfBirth: string;

  @Transform(trim)
  @IsString()
  @Length(5, 500, { message: 'reason must be 5 to 500 characters.' })
  reason: string;
}

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  @Transform(trim)
  homeLocation?: string;

  /**
   * Home location (homeLocationRules; owner, 2026-11-20): the home country (ISO 3166-1 alpha-2, stored in `country`);
   * with Rwanda the home province, district and sector are required (a place of the official directory, else 400
   * UNKNOWN_HOME_LOCATION); with another country they are not asked and the stored ones are cleared (sent anyway:
   * 400 HOME_LOCATION_RWANDA_ONLY). The place is only accepted together with homeCountry (400 HOME_COUNTRY_REQUIRED).
   * Separate from the school location.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2({ message: 'homeCountry must be an ISO 3166-1 alpha-2 code (e.g. RW).' })
  homeCountry?: string;

  @HomePlacePart('homeCountry')
  @IsString() @Length(1, 100) @Transform(trim)
  homeProvince?: string;

  @HomePlacePart('homeCountry')
  @IsString() @Length(1, 100) @Transform(trim)
  homeDistrict?: string;

  @HomePlacePart('homeCountry')
  @IsString() @Length(1, 100) @Transform(trim)
  homeSector?: string;

  /**
   * The caller's Olympiad interests (owner decision 8), replacing the stored ones: one or more of
   * MATHEMATICS, COMPUTING and PHYSICS, no duplicates (capability studentOlympiadInterests).
   */
  @IsOptional()
  @IsArray()
  @NonEmptyUnlessOther()
  @ArrayUnique()
  @IsEnum(OlympiadSubject, { each: true, message: 'olympiadInterests must contain only MATHEMATICS, COMPUTING or PHYSICS.' })
  olympiadInterests?: OlympiadSubject[];

  /**
   * Another Olympiad named in words ("Other"; owner 2026-11-21; capability olympiadInterestOther), 2–100 characters,
   * e.g. "Chemistry". With it, olympiadInterests may be empty. null clears it (only beside at least one subject).
   * Never a subject: grants nothing, not part of Test Management.
   */
  @ValidateIf((o: { olympiadInterestOther?: unknown }) => o.olympiadInterestOther !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOtherInterest()
  olympiadInterestOther?: string | null;
}

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  /** ACTIVE, DEACTIVATED, SUSPENDED or ARCHIVED (capability accountStates). */
  @IsOptional() @IsEnum(AccountStatus) accountStatus?: AccountStatus;
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsEnum(GradeLevel) gradeLevel?: GradeLevel;
  /** Students of this Olympiad level (owner 2026-11-21): JUNIOR, MIDDLE or SENIOR. */
  @IsOptional() @IsEnum(OlympiadLevel) olympiadLevel?: OlympiadLevel;
  @IsOptional() @IsUUID() schoolId?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isApproved?: boolean;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;

  /** false = invited / unverified accounts waiting for activation. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActivated?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  search?: string;
}

