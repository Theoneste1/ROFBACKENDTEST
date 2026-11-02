import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * Query parameters for the admin user-search endpoint.
 * All filters are optional and composable.
 */
export class ListUsersDto {
  /** Filter by global role. */
  @IsOptional()
  @IsEnum(['STUDENT', 'MENTOR', 'ADMIN'], {
    message: 'role must be STUDENT, MENTOR, or ADMIN.',
  })
  role?: string;

  /** Filter to students enrolled at this school (by school ID). */
  @IsOptional()
  @IsUUID()
  schoolId?: string;

  /** Filter to students of a division. */
  @IsOptional()
  @IsUUID()
  divisionId?: string;

  /** Free-text search across firstName, lastName, username, and email. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }: { value: string }) => value?.trim())
  search?: string;

  /** Filter by isApproved status. */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  isApproved?: boolean;

  /** Page number (1-based). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  /** Page size (default: 50, max enforced in service). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;
}
