import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

import { EmailService } from './email.service.js';
import { SendEmailDto } from './dto/send-email.dto.js';
import { ListUsersDto } from './dto/list-users.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { EmailDeliveryStatus } from '../generated/prisma/client.js';

class ListDeliveriesDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(EmailDeliveryStatus)
  status?: EmailDeliveryStatus;
}

/**
 * All routes in this controller are ADMIN only.
 *
 * Email addresses and recipient lists are sensitive — they must never be
 * exposed to non-admin roles.
 */
@ApiTags('Admin · Email')
@Controller('admin/email')
@Roles('ADMIN')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  /** Paginated, filterable user list with email addresses. */
  @Get('users')
  listUsers(@Query() query: ListUsersDto) {
    return this.emailService.listUsers(query);
  }

  /**
   * Queue a bulk e-mail. Returns the job immediately; sending happens in the
   * background. Re-using an idempotencyKey returns the original job
   * (`alreadyExisted: true`) instead of sending again.
   */
  @Post('send')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  send(@Body() body: SendEmailDto, @CurrentUser() user: AuthUser) {
    return this.emailService.sendBulk(body, user);
  }

  /** Jobs with progress counters (no message bodies). */
  @Get('jobs')
  listJobs(@Query() query: PaginationQueryDto) {
    return this.emailService.listJobs(query);
  }

  @Get('jobs/:id')
  getJob(@Param('id', ParseUUIDPipe) id: string) {
    return this.emailService.getJob(id);
  }

  /** Per-recipient delivery status (filter with ?status=FAILED). */
  @Get('jobs/:id/deliveries')
  listDeliveries(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListDeliveriesDto) {
    return this.emailService.listDeliveries(id, query);
  }

  /** Re-queue FAILED deliveries. SENT deliveries are never re-sent. */
  @Post('jobs/:id/retry')
  retryJob(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.emailService.retryJob(id, user);
  }
}
