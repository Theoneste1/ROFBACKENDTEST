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
import { IsEnum, IsIn, IsOptional } from 'class-validator';

import { EmailService } from './email.service.js';
import { SendEmailDto } from './dto/send-email.dto.js';
import { ListUsersDto } from './dto/list-users.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { EmailDeliveryStatus } from '../generated/prisma/client.js';

/** All deliveries: transactional (account e-mails, notifications) and bulk-job ones. */
class ListAllDeliveriesDto extends PaginationQueryDto {
  @IsOptional() @IsEnum(EmailDeliveryStatus) status?: EmailDeliveryStatus;
  /** TRANSACTIONAL = not part of a bulk job; BULK = part of one. Default: both. */
  @IsOptional() @IsIn(['TRANSACTIONAL', 'BULK']) kind?: 'TRANSACTIONAL' | 'BULK';
}

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
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  /** Paginated, filterable user list with email addresses. */
  @Get('users')
  @RequirePermission('email.bulkSend')
  listUsers(@Query() query: ListUsersDto, @CurrentUser() user: AuthUser) {
    return this.emailService.listUsers(query, user);
  }

  /**
   * Queue a bulk e-mail. Returns the job immediately; sending happens in the
   * background. Re-using an idempotencyKey returns the original job
   * (`alreadyExisted: true`) instead of sending again.
   */
  @Post('send')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RequirePermission('email.bulkSend')
  send(@Body() body: SendEmailDto, @CurrentUser() user: AuthUser) {
    return this.emailService.sendBulk(body, user);
  }

  /** Jobs with progress counters (no message bodies). */
  @Get('jobs')
  @RequirePermission('email.bulkSend')
  listJobs(@Query() query: PaginationQueryDto, @CurrentUser() user: AuthUser) {
    return this.emailService.listJobs(query, user);
  }

  @Get('jobs/:id')
  @RequirePermission('email.bulkSend')
  getJob(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.emailService.getJob(id, user);
  }

  /** Per-recipient delivery status (filter with ?status=FAILED). */
  @Get('jobs/:id/deliveries')
  @RequirePermission('email.bulkSend')
  listDeliveries(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListDeliveriesDto, @CurrentUser() user: AuthUser) {
    return this.emailService.listDeliveries(id, query, user);
  }

  /**
   * Every e-mail delivery, newest first (e.g. ?status=FAILED&kind=TRANSACTIONAL for failed
   * invitations, activation and reset e-mails). Never returns message bodies (one-time links).
   */
  @Get('deliveries')
  @RequirePermission('email.bulkSend')
  listAllDeliveries(@Query() query: ListAllDeliveriesDto, @CurrentUser() user: AuthUser) {
    return this.emailService.listAllDeliveries(query, user);
  }

  /** Re-queue one FAILED delivery (transactional or bulk). Anything else: 409. */
  @Post('deliveries/:id/retry')
  @RequirePermission('email.bulkSend')
  retryDelivery(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.emailService.retryDelivery(id, user);
  }

  /** Re-queue FAILED deliveries. SENT deliveries are never re-sent. */
  @Post('jobs/:id/retry')
  @RequirePermission('email.bulkSend')
  retryJob(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.emailService.retryJob(id, user);
  }
}
