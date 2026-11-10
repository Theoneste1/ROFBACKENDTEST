import {
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { GradeLevel } from '../../generated/prisma/client.js';
import { IsStrongPassword, lower, trim } from './password.rules.js';

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
   * school. Required unless schoolName is sent.
   */
  @ValidateIf((o: RegisterStudentDto) => o.schoolCode !== undefined || o.schoolName === undefined)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'schoolCode must be the 6-digit official school code.' })
  @Transform(trim)
  schoolCode?: string;

  /**
   * Another country: the school's name as entered (unverified; no school is linked).
   * Rwanda, legacy (until the sign-up form sends schoolCode): it never creates a
   * school and links the student only when it matches exactly one school of the
   * official list — otherwise no school until an Administrator sets it.
   * Ignored when schoolCode is sent.
   */
  @ValidateIf((o: RegisterStudentDto) => o.schoolCode === undefined)
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  schoolName?: string;

  /** Legacy, with schoolName: city / region of the school (not stored). */
  @IsOptional()
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  schoolLocation?: string;

  /** Student's home city / region. */
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  homeLocation: string;
}
