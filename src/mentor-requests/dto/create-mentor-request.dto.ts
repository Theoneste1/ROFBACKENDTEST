import {
  IsInt, Max, Min,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  Length,
  Matches,
  IsBoolean,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { HomePlacePart } from '../../common/home-place.js';
import { CoachEducationLevel, Gender, MentorRequestStatus, OlympiadSubject } from '../../generated/prisma/client.js';
import { IsStrongPassword, lower, trim } from '../../auth/dto/password.rules.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { IsOtherInterest, NonEmptyUnlessOther } from '../../users/olympiad-interests.rules.js';

export class CreateMentorRequestDto {
  @IsString()
  @Length(2, 50)
  @Transform(trim)
  firstName: string;

  @IsString()
  @Length(2, 50)
  @Transform(trim)
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

  /** FEMALE or MALE. Required (owner, 2026-11-20: gender is asked at every sign-up). Not audited. */
  @IsEnum(Gender, { message: 'gender must be FEMALE or MALE.' })
  gender: Gender;

  // ─── Application details (capability coachApplicationDetails; optional for older clients, except the subjects) ───
  // No passport or national ID: the existing system does not require one.

  /**
   * The applicant's home country (ISO 3166-1 alpha-2). Required (homeLocationRules, owner 2026-11-20). Copied to the
   * Coach account on approval.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2({ message: 'country must be an ISO 3166-1 alpha-2 code (e.g. RW).' })
  country: string;

  /**
   * Home location (homeLocationRules): required when the home country is Rwanda — a place of the official directory,
   * else 400 UNKNOWN_HOME_LOCATION; with another country not asked (sent anyway: 400 HOME_LOCATION_RWANDA_ONLY).
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

  /** Current or most recent occupation, as entered (2–200 characters). */
  @IsOptional()
  @IsString()
  @Length(2, 200)
  @Transform(trim)
  occupation?: string;

  /** Highest education level. */
  @IsOptional()
  @IsEnum(CoachEducationLevel, { message: 'educationLevel must be one of SECONDARY, DIPLOMA, BACHELOR, MASTER, DOCTORATE, OTHER.' })
  educationLevel?: CoachEducationLevel;

  /**
   * The subjects the applicant would like to coach: one or more of MATHEMATICS, COMPUTING, PHYSICS (no duplicates).
   * REQUIRED for every new application (owner decision 2026-11-19, capability coachOlympiadInterests). Copied to the Coach
   * account on approval; information only — it never grants marking or any other permission.
   */
  @IsArray({ message: 'olympiadInterests must name at least one of MATHEMATICS, COMPUTING or PHYSICS.' })
  @NonEmptyUnlessOther()
  @ArrayUnique({ message: 'olympiadInterests must not name a subject twice.' })
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

  /** Phone, stored in E.164 (else 400 INVALID_PHONE). REG-06. */
  @IsOptional()
  @IsString() @Length(1, 40) @Transform(trim)
  phone?: string;

  /** Institution or affiliation, where applicable (2–200). */
  @IsOptional()
  @IsString() @Length(2, 200) @Transform(trim)
  affiliation?: string;

  /** Areas of expertise (2–1000). */
  @IsOptional()
  @IsString() @Length(2, 1000) @Transform(trim)
  expertise?: string;

  /** Relevant experience, e.g. Olympiad coaching, teaching, competitions (2–2000). */
  @IsOptional()
  @IsString() @Length(2, 2000) @Transform(trim)
  relevantExperience?: string;

  /** Years of relevant experience, 0–60. */
  @IsOptional()
  @IsInt() @Min(0) @Max(60)
  yearsOfExperience?: number;
}

/**
 * PATCH /mentor-requests/:id/approve (optional body). Picture moderation (owner approval 2026-11-18): the picture
 * sent with the application becomes the coach's picture ONLY with approvePicture true, after the Administrator saw it
 * (GET /mentor-requests/:id/avatar). Omitted or false: discarded.
 */
export class ApproveMentorRequestDto {
  @IsOptional()
  @IsBoolean()
  approvePicture?: boolean;
}

/** PATCH /mentor-requests/:id/reject: an optional reason, e-mailed to the applicant (REG-10). */
export class RejectMentorRequestDto {
  @IsOptional()
  @IsString() @Length(2, 500) @Transform(trim)
  reason?: string;
}

export class ListMentorRequestsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(MentorRequestStatus)
  status?: MentorRequestStatus;
}
