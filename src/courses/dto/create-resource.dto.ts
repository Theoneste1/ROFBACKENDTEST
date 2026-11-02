import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ResourceType } from '../../generated/prisma/client.js';

export class CreateResourceDto {
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
