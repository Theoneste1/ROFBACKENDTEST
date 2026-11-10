import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { GradeLevel, Role } from '../../generated/prisma/client.js';
import { IsStrongPassword, lower, trim } from '../../auth/dto/password.rules.js';
import { PaginationQueryDto } from '../../common/pagination.js';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Length(3, 30)
  @Matches(/^[a-z0-9._-]+$/, { message: 'Username may contain letters, digits, ".", "_" and "-" only.' })
  @Transform(lower)
  username?: string;

  @IsOptional()
  @IsEmail()
  @Transform(lower)
  email?: string;

  @IsOptional()
  @IsStrongPassword()
  password?: string;

  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /**
   * Your own current password (step-up, P1-08). Required to change a role to or
   * from ADMIN or SUPER_ADMIN; otherwise ignored. Never stored or logged.
   */
  @IsOptional()
  @IsString()
  @Length(1, 200)
  currentPassword?: string;

  /** Changing the grade moves a student to the matching division. */
  @IsOptional()
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

export class UpdateUserStatusDto {
  /** false suspends the account immediately (all sessions are revoked). */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Approve a student or mentor waiting for approval. */
  @IsOptional()
  @IsBoolean()
  isApproved?: boolean;
}

export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  firstName?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  lastName?: string;

  @IsOptional()
  @IsString()
  @Length(2, 200)
  @Transform(trim)
  homeLocation?: string;
}

export class ListUsersQueryDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsUUID() divisionId?: string;
  @IsOptional() @IsEnum(GradeLevel) gradeLevel?: GradeLevel;
  @IsOptional() @IsUUID() schoolId?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isApproved?: boolean;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;

  /** false = invited / unverified accounts waiting for activation. */
  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActivated?: boolean;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  search?: string;
}

