import {
  IsEmail,
  IsEnum,
  IsString,
  Length,
  Matches,
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

  /** Name of the school attended. Normalised to Title Case and de-duplicated. */
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  schoolName: string;

  /** City / region where the school is located. */
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  schoolLocation: string;

  /** Student's home city / region. */
  @IsString()
  @Length(2, 200)
  @Transform(titleCase)
  homeLocation: string;
}
