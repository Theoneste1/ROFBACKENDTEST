import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

import { PaginationQueryDto } from '../../common/pagination.js';
import { NotificationOutboxStatus } from '../../generated/prisma/client.js';

/** GET /admin/notification-deliveries */
export class ListDeliveriesDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(NotificationOutboxStatus)
  status?: NotificationOutboxStatus;

  /** Event type, e.g. "teacher.application.approved". */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  type?: string;
}
