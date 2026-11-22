import {
  IsIn, IsInt, Max, Min,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
  IsBoolean,
} from 'class-validator';
import { Transform } from 'class-transformer';

import { HomePlacePart } from '../../common/home-place.js';
import { Gender, OlympiadSubject, SchoolAccommodation, TeacherApplicationStatus } from '../../generated/prisma/client.js';
import { SCHOOL_OWNERSHIP } from '../../schools/school-rules.js';
import { IsStrongPassword, lower, trim } from '../../auth/dto/password.rules.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { IsOtherInterest, NonEmptyUnlessOther } from '../../users/olympiad-interests.rules.js';

/** Trim and collapse inner whitespace. */
const squash = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value);

/**
 * POST /auth/register/teacher — a Teacher application (no account until an Administrator approves it).
 * The school is EITHER a listed school (schoolId; its code, name and sector come from the database) OR a
 * missing one (proposedSchoolName + schoolSector). Places come from GET /schools/locations.
 */
export class RegisterTeacherDto {
  @IsString() @Length(1, 100) @Transform(trim)
  firstName: string;

  @IsString() @Length(1, 100) @Transform(trim)
  lastName: string;

  @IsString()
  @Length(3, 30)
  @Matches(/^[a-z0-9._-]+$/, { message: 'Username may contain letters, digits, ".", "_" and "-" only.' })
  @Transform(lower)
  username: string;

  @IsEmail()
  @Transform(lower)
  email: string;

  @IsStrongPassword()
  password: string;

  /** Must equal password (400 PASSWORD_MISMATCH); never stored. */
  @IsString()
  confirmPassword: string;

  /** The applicant's home country, ISO 3166-1 alpha-2 (e.g. RW); with RW the home province, district and sector are required. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2({ message: 'country must be an ISO 3166-1 alpha-2 code (e.g. RW).' })
  country: string;

  /** Stored in E.164 (Rwanda: 07XXXXXXXX or +2507XXXXXXXX; elsewhere +country number) — else 400 INVALID_PHONE. */
  @IsString() @Length(1, 40) @Transform(trim)
  phone: string;

  /** FEMALE or MALE. Required (owner, 2026-11-20: gender is asked at every sign-up). Not audited. */
  @IsEnum(Gender, { message: 'gender must be FEMALE or MALE.' })
  gender: Gender;

  /** One or more of MATHEMATICS, COMPUTING, PHYSICS (no duplicates). */
  @IsArray()
  @NonEmptyUnlessOther()
  @ArrayUnique()
  @IsEnum(OlympiadSubject, { each: true, message: 'olympiadInterests must contain only MATHEMATICS, COMPUTING or PHYSICS.' })
  olympiadInterests: OlympiadSubject[];

  /**
   * Another Olympiad named in words ("Other"; owner 2026-11-21; capability olympiadInterestOther), 2–100 characters,
   * e.g. "Chemistry". With it, olympiadInterests may be empty. null clears it (only beside at least one subject).
   * Never a subject: grants nothing, not part of Test Management.
   */
  @ValidateIf((o: { olympiadInterestOther?: unknown }) => o.olympiadInterestOther !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOtherInterest()
  olympiadInterestOther?: string | null;

  @IsString() @Length(1, 100) @Transform(trim)
  schoolProvince: string;

  @IsString() @Length(1, 100) @Transform(trim)
  schoolDistrict: string;

  /** A listed school (GET /schools/search). Exactly one of schoolId / proposedSchoolName. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  /** "My school is missing": its name, with schoolSector. Exactly one of schoolId / proposedSchoolName. */
  @IsOptional()
  @IsString() @Length(2, 200) @Transform(squash)
  proposedSchoolName?: string;

  /**
   * Required with proposedSchoolName; refused with schoolId (a listed school's sector comes from the
   * directory — 400 SCHOOL_CHOICE_REQUIRED).
   */
  @ValidateIf((o: RegisterTeacherDto) => o.proposedSchoolName !== undefined || o.schoolSector !== undefined)
  @IsString() @Length(1, 100) @Transform(trim)
  schoolSector?: string;

  // ─── "My school is not listed": the school's official details (owner decision 2026-11-22) ──────────────────
  // Required with proposedSchoolName (code, ownership, day / boarding); cell and village optional. Refused with
  // schoolId (400 SCHOOL_CHOICE_REQUIRED). The approval creates the school from them — nothing is typed again.

  /** The school's official 6-digit code (Ministry of Education list); not yet in the directory (409 SCHOOL_CODE_LISTED). */
  @ValidateIf((o: RegisterTeacherDto) => o.proposedSchoolName !== undefined || o.proposedSchoolCode !== undefined)
  @Transform(trim) @IsString() @Matches(/^\d{6}$/, { message: 'proposedSchoolCode must be the 6-digit official school code' })
  proposedSchoolCode?: string;

  @IsOptional() @IsString() @Length(1, 100) @Transform(squash)
  proposedSchoolCell?: string;

  @IsOptional() @IsString() @Length(1, 100) @Transform(squash)
  proposedSchoolVillage?: string;

  @ValidateIf((o: RegisterTeacherDto) => o.proposedSchoolName !== undefined || o.proposedSchoolOwnership !== undefined)
  @IsIn(SCHOOL_OWNERSHIP, { message: `proposedSchoolOwnership must be one of: ${SCHOOL_OWNERSHIP.join(', ')}` })
  proposedSchoolOwnership?: (typeof SCHOOL_OWNERSHIP)[number];

  @ValidateIf((o: RegisterTeacherDto) => o.proposedSchoolName !== undefined || o.proposedSchoolAccommodation !== undefined)
  @IsEnum(SchoolAccommodation, { message: 'proposedSchoolAccommodation must be DAY, BOARDING or MIXED' })
  proposedSchoolAccommodation?: SchoolAccommodation;

  /** Position or teaching role at the school (2–100 characters; REG-05). Optional for older clients. */
  @IsOptional()
  @IsString() @Length(2, 100) @Transform(trim)
  position?: string;

  /** Years of teaching experience, 0–60 (REG-05). Optional. */
  @IsOptional()
  @IsInt() @Min(0) @Max(60)
  yearsOfExperience?: number;

  /**
   * Home location (homeLocationRules): required when the home country (`country`) is Rwanda — a place of the official
   * directory, else 400 UNKNOWN_HOME_LOCATION; with another country not asked (sent anyway: 400 HOME_LOCATION_RWANDA_ONLY).
   */
  @HomePlacePart('country')
  @IsString() @Length(1, 100) @Transform(trim)
  homeProvince?: string;

  @HomePlacePart('country')
  @IsString() @Length(1, 100) @Transform(trim)
  homeDistrict?: string;

  @HomePlacePart('country')
  @IsString() @Length(1, 100) @Transform(trim)
  homeSector?: string;
}

/** GET /admin/teacher-applications */
export class ListTeacherApplicationsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(TeacherApplicationStatus)
  status?: TeacherApplicationStatus;
}

/** POST /admin/teacher-applications/:id/approve */
export class ApproveTeacherApplicationDto {
  /** Required for a missing-school application (the school the Administrator created or chose); otherwise omit it or send the application's school. */
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsString() @MaxLength(500) @Transform(trim)
  note?: string;

  /**
   * Picture moderation (owner approval 2026-11-18): the picture sent with the application becomes the account's
   * picture ONLY when the Administrator, having seen it (GET …/:id/avatar), sends true. Omitted or false: it is
   * discarded and the account starts without a picture.
   */
  @IsOptional()
  @IsBoolean()
  approvePicture?: boolean;

  /**
   * An unlisted-school application whose school is created by this approval (owner 2026-11-22): true confirms a
   * school with the same name in the same district is a different school (409 POSSIBLE_DUPLICATE otherwise).
   */
  @IsOptional()
  @IsBoolean()
  confirmPossibleDuplicate?: boolean;
}

/** POST /admin/teacher-applications/:id/reject */
export class RejectTeacherApplicationDto {
  @IsString() @Length(2, 500) @Transform(trim)
  reason: string;
}

/** POST /admin/teacher-applications/:id/school */
export class VerifyTeacherApplicationSchoolDto {
  /** An existing, active school in Rwanda (create it first through POST /admin/schools when needed). */
  @IsUUID()
  schoolId: string;

  @IsOptional()
  @IsString() @MaxLength(500) @Transform(trim)
  note?: string;
}
