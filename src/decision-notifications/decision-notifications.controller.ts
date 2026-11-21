import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { DecisionNotificationsService } from './decision-notifications.service.js';
import { ListDeliveriesDto } from './dto/list-deliveries.dto.js';

/**
 * Delivery log of decision notifications (school verified, application approved, permissions granted):
 * status, attempts and the sanitised last error — never the message itself. email.bulkSend
 * (Administrators and Super Admins).
 */
@ApiTags('Admin · Email')
@ApiBearerAuth()
@Controller('admin/notification-deliveries')
export class DecisionNotificationsController {
  constructor(private readonly service: DecisionNotificationsService) {}

  @Get()
  @RequirePermission('email.bulkSend')
  list(@Query() query: ListDeliveriesDto) {
    return this.service.list(query);
  }

  /** Re-queue a FAILED delivery and send it again (409 NOTIFICATION_ALREADY_SENT / NOTIFICATION_SENDING). */
  @Post(':id/retry')
  @HttpCode(200)
  @RequirePermission('email.bulkSend')
  retry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.retry(id, user);
  }
}
