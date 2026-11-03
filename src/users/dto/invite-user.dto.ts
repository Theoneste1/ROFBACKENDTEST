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

  /** Existing school id … */
  @IsOptional()
  @Transform(emptyToUndefined)
  @IsUUID()
  schoolId?: string;

  /** … or a school name (created if new, normalised to Title Case). */
  @IsOptional()
  @Transform(titleCase)
  @IsString()
  @Length(2, 200)
  schoolName?: string;

  @ValidateIf((o) => !!o.schoolName)
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
