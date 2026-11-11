import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { GradeLevel, Role } from '../../generated/prisma/client.js';
import { lower, trim } from '../../auth/dto/password.rules.js';
import { toTitleCase } from '../../auth/dto/register-student.dto.js';

const titleCase = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() ? toTitleCase(value) : undefined;
const emptyToUndefined = ({ value }: { value: unknown }) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/**
 * Invite a person: the account is created without a password and an
 * activation link is e-mailed. Also the shape of one CSV import row.
 */
export class InviteUserDto {
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  firstName: string;

  @IsString()
  @Length(1, 100)
  @Transform(trim)
  lastName: string;

  @IsEmail()
  @Transform(lower)
  email: string;

  /** Optional; generated from the e-mail address when omitted. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined))
  @IsString()
  @Length(3, 30)
  @Matches(/^[a-z0-9._-]+$/, { message: 'username may contain letters, digits, ".", "_" and "-" only.' })
  username?: string;

  /** Defaults to STUDENT. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : undefined))
  @IsEnum(Role)
  role?: Role;

  /** Required for students (S1–S6); determines the division. */
  @ValidateIf((o) => (o.role ?? 'STUDENT') === 'STUDENT')
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(GradeLevel, { message: 'gradeLevel must be one of S1, S2, S3, S4, S5, S6.' })
  gradeLevel?: GradeLevel;

  /**
   * The student's school: an EXISTING school, by id and/or official code (PR B). Invitations and
   * CSV imports never create a school — an Administrator creates it first (POST /admin/schools).
   */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  schoolId?: string;

  /** A Rwandan school's 6-digit official code (alternative to schoolId; both must name the same school). */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? (value.trim() || undefined) : value))
  @IsString()
  @Matches(/^\d{6}$/, { message: 'schoolCode must be exactly 6 digits.' })
  schoolCode?: string;

  /**
   * Optional check only: when given with schoolCode / schoolId it must be that school's name
   * (case, accents and punctuation ignored), otherwise the invitation or row is refused
   * (SCHOOL_NAME_MISMATCH). Alone it is refused (SCHOOL_REFERENCE_REQUIRED) — it never creates
   * or matches a school.
   */
  @IsOptional()
  @Transform(titleCase)
  @IsString()
  @Length(2, 200)
  schoolName?: string;

  /** Accepted for compatibility with earlier clients and CSV files; not used (the school's own location applies). */
  @IsOptional()
  @Transform(titleCase)
  @IsString()
  @Length(2, 200)
  schoolLocation?: string;

  @IsOptional()
  @Transform(titleCase)
  @IsString()
  @Length(2, 200)
  homeLocation?: string;
}

export class ImportUsersQueryDto {
  /** Validate only; create nothing. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  dryRun?: boolean;
}
