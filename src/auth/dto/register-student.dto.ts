import {
  IsEmail,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';

/** Normalise a string to Title Case, trim whitespace. */
const toTitleCase = (value: string) =>
  value
    .trim()
    .replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

export class RegisterStudentDto {
  @IsString()
  @Length(1, 100)
  @Transform(({ value }: { value: string }) => value?.trim())
  firstName: string;

  @IsString()
  @Length(1, 100)
  @Transform(({ value }: { value: string }) => value?.trim())
  lastName: string;

  @IsString()
  @Length(3, 30)
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  username: string;

  @IsEmail()
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  email: string;

  @IsString()
  @Length(8, 100)
  @Matches(/(?=.*[a-zA-Z])(?=.*[0-9])/, {
    message: 'Password must contain at least one letter and one number.',
  })
  password: string;

  /** Name of the school attended. Will be normalised to Title Case and
   *  matched against existing School records to avoid duplicates. */
  @IsString()
  @Length(2, 200)
  @Transform(({ value }: { value: string }) => toTitleCase(value))
  schoolName: string;

  /** City / region where the school is located. */
  @IsString()
  @Length(2, 200)
  @Transform(({ value }: { value: string }) => toTitleCase(value))
  schoolLocation: string;

  /** Student's home city / region. */
  @IsString()
  @Length(2, 200)
  @Transform(({ value }: { value: string }) => toTitleCase(value))
  homeLocation: string;
}
