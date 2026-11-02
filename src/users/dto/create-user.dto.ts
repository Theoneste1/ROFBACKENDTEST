import {
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
import { IsStrongPassword, lower, trim } from '../../auth/dto/password.rules.js';

export class CreateUserDto {
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

  /** Defaults to STUDENT when omitted. */
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /** Required for students; determines the division. */
  @ValidateIf((o) => (o.role ?? 'STUDENT') === 'STUDENT')
  @IsEnum(GradeLevel)
  gradeLevel?: GradeLevel;

  @IsOptional()
  @IsUUID()
  schoolId?: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  @Transform(trim)
  homeLocation?: string;
}
