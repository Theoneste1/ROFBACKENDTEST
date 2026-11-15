import {
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsEmail,
  IsEnum,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { CoachEducationLevel, MentorRequestStatus, OlympiadSubject } from '../../generated/prisma/client.js';
import { IsStrongPassword, lower, trim } from '../../auth/dto/password.rules.js';
import { PaginationQueryDto } from '../../common/pagination.js';

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

  // ─── Application details (capability coachApplicationDetails; optional for older clients) ───
  // No passport or national ID: the existing system does not require one.

  /** The applicant's country (ISO 3166-1 alpha-2). Copied to the Coach account on approval. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsISO31661Alpha2({ message: 'country must be an ISO 3166-1 alpha-2 code (e.g. RW).' })
  country?: string;

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

  /** One or more of MATHEMATICS, COMPUTING, PHYSICS (no duplicates). Copied to the Coach account on approval; information only. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty({ message: 'olympiadInterests must name at least one of MATHEMATICS, COMPUTING or PHYSICS.' })
  @ArrayUnique()
  @IsEnum(OlympiadSubject, { each: true, message: 'olympiadInterests must contain only MATHEMATICS, COMPUTING or PHYSICS.' })
  olympiadInterests?: OlympiadSubject[];
}

export class ListMentorRequestsDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(MentorRequestStatus)
  status?: MentorRequestStatus;
}
