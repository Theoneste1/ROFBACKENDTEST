import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ResourceType } from '../../generated/prisma/client.js';
import { ResourceMetadataDto } from './resource-metadata.dto.js';

export class CreateResourceDto extends ResourceMetadataDto {
  /** Which division (Junior/Senior) this material is for. */
  @IsUUID()
  divisionId: string;

  @IsEnum(ResourceType, {
    message: `type must be one of: ${Object.values(ResourceType).join(', ')}`,
  })
  type: ResourceType;

  @IsString()
  @Length(2, 200)
  @Transform(({ value }: { value: string }) => value?.trim())
  title: string;

  @IsOptional()
  @IsString()
  @Length(1, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  description?: string;

  /**
   * Display order within the course (lower number = shown first).
   * Defaults to 0 when not supplied.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  sortOrder?: number;
}

export class ListResourcesDto {
  /** Admins and mentors: filter to one division. Ignored for students. */
  @IsOptional()
  @IsUUID()
  divisionId?: string;

  @IsOptional()
  @IsEnum(ResourceType)
  type?: ResourceType;

  /** Resources carrying this tag. */
  @IsOptional()
  @IsString()
  @Length(1, 40)
  @Transform(({ value }: { value: string }) => value?.trim().toLowerCase())
  tag?: string;

  /** Exam / publication year. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1800)
  year?: number;

  /** Search title, description, author and source. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(({ value }: { value: string }) => value?.trim())
  q?: string;

  /** Mentors/admins: include archived resources. */
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeArchived?: boolean;
}
