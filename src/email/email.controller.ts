import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';

import { EmailService } from './email.service.js';
import { SendEmailDto } from './dto/send-email.dto.js';
import { ListUsersDto } from './dto/list-users.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

/**
 * All routes in this controller are ADMIN only.
 *
 * Email addresses and recipient lists are sensitive — they must never be
 * exposed to non-admin roles.
 */
@Controller('admin/email')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class EmailController {
  constructor(private readonly emailService: EmailService) {}

  // ─── User search ──────────────────────────────────────────────────────────

  /**
   * Paginated, filterable user list with email addresses.
   * Supports filtering by role, school, approval status, and free-text search.
   *
   * GET /admin/email/users?role=STUDENT&search=alice&page=1&limit=50
   */
  @Get('users')
  listUsers(@Query() query: ListUsersDto) {
    return this.emailService.listUsers(query);
  }

  // ─── Bulk email ───────────────────────────────────────────────────────────

  /**
   * Dispatch a bulk email job.
   *
   * Returns a job record immediately. Delivery runs in the background.
   * Use the idempotencyKey to safely retry without duplicate sends.
   *
   * Response includes `alreadyExisted: true` when the key was already used,
   * which means the original job is returned unchanged.
   *
   * POST /admin/email/send
   */
  @Post('send')
  send(@Body() body: SendEmailDto, @Request() req: any) {
    return this.emailService.sendBulk(body, { id: req.user.id, role: req.user.role });
  }

  /**
   * List all email jobs (no message bodies — subject + counts only).
   *
   * GET /admin/email/jobs
   */
  @Get('jobs')
  listJobs() {
    return this.emailService.listJobs();
  }

  /**
   * Get a single job with full per-recipient delivery records.
   * Shows which addresses were accepted or failed and any error messages.
   * Message body is not included in the response.
   *
   * GET /admin/email/jobs/:id
   */
  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.emailService.getJob(id);
  }

  /**
   * Retry all FAILED deliveries for a job.
   * SENT deliveries are never re-processed — no duplicate sends.
   *
   * POST /admin/email/jobs/:id/retry
   */
  @Post('jobs/:id/retry')
  retryJob(@Param('id') id: string, @Request() req: any) {
    return this.emailService.retryJob(id, { id: req.user.id, role: req.user.role });
  }
}
