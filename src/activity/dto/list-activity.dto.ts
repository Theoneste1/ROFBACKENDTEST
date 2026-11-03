import { IsEnum, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { ActivityType } from '../../generated/prisma/client.js';
import { PaginationQueryDto } from '../../common/pagination.js';

export class ListActivityDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() userId?: string;
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsEnum(ActivityType) type?: ActivityType;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

export class ActivitySummaryDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}
