import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { GradeLevel, OlympiadSubject } from '../../generated/prisma/client.js';
import { IsStrongPassword, lower, trim } from './password.rules.js';
import { IsNormalisablePhone, IsStudentDateOfBirth } from './registration-details.rules.js';

/** True when any part of the official home place is sent (then all three are required). */
export const hasHomePlace = (o: { homeProvince?: unknown; homeDistrict?: unknown; homeSector?: unknown }) =>
  o.homeProvince !== undefined || o.homeDistrict !== undefined || o.homeSector !== undefined;

/** Normalise a string to Title Case, trim whitespace. */
export const toTitleCase = (value: string) =>
  value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

const titleCase = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? toTitleCase(value) : value;

export class RegisterStudentDto {
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  firstName: string;

  @IsString()
  @Length(1, 100)
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

  /** S1–S3 places the student in the Junior division, S4–S6 in Senior. */
  @IsEnum(GradeLevel, { message: 'gradeLevel must be one of S1, S2, S3, S4, S5, S6.' })
  gradeLevel: GradeLevel;

  /**
   * Country of the school (ISO 3166-1 alpha-2). Default RW (Rwanda). Rwanda: the school
   * comes from the official directory (schoolCode). Any other country: the school name
   * is recorded as entered, unverified — never matched to a Rwandan school.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2({ message: 'country must be an ISO 3166-1 alpha-2 code (e.g. RW).' })
  country?: string;

  /**
   * Rwanda: official code of the school attended (6 digits, from GET /schools/search or
   * the Province → District → Sector listing). The student is linked to exactly that
   * school. Required unless schoolId or schoolName is sent.
   */
  @ValidateIf((o: RegisterStudentDto) => o.schoolCode !== undefined || (o.schoolName === undefined && o.schoolId === undefined))
  @IsString()
  @Matches(/^\d{6}$/, { message: 'schoolCode must be the 6-digit official school code.' })
  @Transform(trim)
  schoolCode?: string;

  /**
   * Rwanda (owner decision 2026-11-14): the internal id of the school attended, from
   * GET /schools/search — how a school WITHOUT an official code is chosen (any school of the
   * list may be chosen this way). It must be an active Rwandan school (400 UNKNOWN_SCHOOL,
   * 409 SCHOOL_INACTIVE); the claim is PENDING exactly as with schoolCode. Not with schoolCode
   * (400). schoolName and the place fields are ignored when it is sent.
   */
  @IsOptional()
  @IsUUID('all', { message: 'schoolId must be the id of a school from the list.' })
  schoolId?: string;

  /**
   * Another country: the school's name as entered (unverified; no school is linked).
   * Rwanda, legacy (until the sign-up form sends schoolCode): it never creates a
   * school and links the student only when it matches exactly one school of the
   * official list — otherwise no school until an Administrator sets it.
   * Ignored when schoolCode or schoolId is sent.
   */
  @ValidateIf((o: RegisterStudentDto) => o.schoolCode === undefined && o.schoolId === undefined)
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  schoolName?: string;

  /**
   * Rwanda, "My school is not listed" (PR C): the school's place in the official directory, sent
   * with schoolName — all three together (from GET /schools/locations). The claim keeps the name
   * and place, PENDING until an Administrator matches and verifies it; an exact unique match with
   * an active official school in that sector links that school (still PENDING).
   */
  @ValidateIf((o: RegisterStudentDto) => o.schoolProvince !== undefined || o.schoolDistrict !== undefined || o.schoolSector !== undefined)
  @IsString() @Length(1, 100) @Transform(trim)
  schoolProvince?: string;

  @ValidateIf((o: RegisterStudentDto) => o.schoolProvince !== undefined || o.schoolDistrict !== undefined || o.schoolSector !== undefined)
  @IsString() @Length(1, 100) @Transform(trim)
  schoolDistrict?: string;

  @ValidateIf((o: RegisterStudentDto) => o.schoolProvince !== undefined || o.schoolDistrict !== undefined || o.schoolSector !== undefined)
  @IsString() @Length(1, 100) @Transform(trim)
  schoolSector?: string;

  /** Legacy, with schoolName: city / region of the school (not stored). */
  @IsOptional()
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  schoolLocation?: string;

  /**
   * Student's home city / region. Required unless the official home place (homeProvince, homeDistrict,
   * homeSector) is sent; then it is optional and stored as "Sector, District".
   */
  @ValidateIf((o: RegisterStudentDto) => o.homeLocation !== undefined || !hasHomePlace(o))
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  homeLocation?: string;

  // ─── Registration details (capability studentRegistrationDetails; optional for older clients) ───

  /**
   * Date of birth, "YYYY-MM-DD": a real past date, age 5–30 on the day of registration (Rwanda). Not audited.
   * Required (owner, 2026-11-17: every student is asked their date of birth at registration).
   */
  @Transform(trim)
  @IsStudentDateOfBirth()
  dateOfBirth: string;

  /** The student's own phone (optional), stored in E.164 (teacher-application rules). Not audited. */
  @IsOptional()
  @Transform(trim)
  @IsNormalisablePhone()
  phone?: string;

  /**
   * A close-family member's phone, stored in E.164 (teacher-application rules). Required (owner decision 9.2,
   * 2026-11-18: the server requires it, not only the form) — missing, empty or not a valid phone number is refused.
   * Not audited.
   */
  @Transform(trim)
  @IsNotEmpty({ message: 'guardianPhone (the phone number of a close-family member) is required.' })
  @IsNormalisablePhone()
  guardianPhone: string;

  /** The student's own country (ISO 3166-1 alpha-2), stored in User.country. `country` stays the school's. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2({ message: 'homeCountry must be an ISO 3166-1 alpha-2 code (e.g. RW).' })
  homeCountry?: string;

  /**
   * The official home place (Rwanda only; a place of GET /schools/locations, else 400 UNKNOWN_HOME_LOCATION;
   * with another homeCountry 400 HOME_LOCATION_RWANDA_ONLY). All three together.
   */
  @ValidateIf((o: RegisterStudentDto) => hasHomePlace(o))
  @IsString() @Length(1, 100) @Transform(trim)
  homeProvince?: string;

  @ValidateIf((o: RegisterStudentDto) => hasHomePlace(o))
  @IsString() @Length(1, 100) @Transform(trim)
  homeDistrict?: string;

  @ValidateIf((o: RegisterStudentDto) => hasHomePlace(o))
  @IsString() @Length(1, 100) @Transform(trim)
  homeSector?: string;

  /**
   * Olympiads the student is interested in (owner decision 8): one or more of MATHEMATICS, COMPUTING and
   * PHYSICS, no duplicates (capability studentOlympiadInterests). Optional for older clients (the account then
   * has none); the sign-up form requires at least one. Information only: no programme membership, no permissions.
   */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'olympiadInterests must name at least one of MATHEMATICS, COMPUTING or PHYSICS.' })
  @ArrayUnique()
  @IsEnum(OlympiadSubject, { each: true, message: 'olympiadInterests must contain only MATHEMATICS, COMPUTING or PHYSICS.' })
  olympiadInterests?: OlympiadSubject[];
}
