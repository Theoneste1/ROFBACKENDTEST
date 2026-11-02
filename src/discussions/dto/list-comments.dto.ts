import { IsInt, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ListCommentsDto {
  /** Page number (1-based). Default: 1. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  /** Page size. Default: 20. Maximum: 100. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}
