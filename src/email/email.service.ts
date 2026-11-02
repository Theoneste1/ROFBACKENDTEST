import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SmtpService } from './smtp.service.js';
import { SendEmailDto, RecipientMode } from './dto/send-email.dto.js';
import { ListUsersDto } from './dto/list-users.dto.js';
import type { CallerCtx } from '../submissions/submissions.service.js';

const MAX_PAGE_SIZE = 100;

/** Fields returned in user-list responses (email included for admin use). */
const USER_LIST_SELECT = {
  id:          true,
  firstName:   true,
  lastName:    true,
  username:    true,
  email:       true,
  role:        true,
  isApproved:  true,
  avatarUrl:   true,
  createdAt:   true,
  school: {
    select: { id: true, name: true, location: true },
  },
} as const;

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly smtp:   SmtpService,
    private readonly audit:  AuditService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // User search / filter (admin view with email)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Paginated, filterable user list for admin use.
   * Returns email addresses — only admins may call this endpoint.
   */
  async listUsers(query: ListUsersDto) {
    const page  = query.page  ?? 1;
    const limit = Math.min(query.limit ?? 50, MAX_PAGE_SIZE);
    const skip  = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (query.role)       where['role']       = query.role;
    if (query.schoolId)   where['schoolId']   = query.schoolId;
    if (query.isApproved !== undefined) where['isApproved'] = query.isApproved;

    if (query.search) {
      const term = query.search;
      where['OR'] = [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName:  { contains: term, mode: 'insensitive' } },
        { username:  { contains: term, mode: 'insensitive' } },
        { email:     { contains: term, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select:  USER_LIST_SELECT,
        orderBy: [{ role: 'asc' }, { lastName: 'asc' }, { firstName: 'asc' }],
        skip,
        take:    limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Bulk email — create job + dispatch
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create and immediately enqueue a bulk email job.
   *
   * If the idempotencyKey already exists, returns the existing job
   * (no duplicate dispatch).
   *
   * Returns a job summary immediately. Delivery runs in the background;
   * poll `GET /email/jobs/:id` for status.
   */
  async sendBulk(dto: SendEmailDto, caller: CallerCtx) {
    // ── Idempotency check ──────────────────────────────────────────────────
    const existing = await this.prisma.emailJob.findUnique({
      where:  { idempotencyKey: dto.idempotencyKey },
      select: {
        id:             true,
        status:         true,
        totalRecipients: true,
        sentCount:      true,
        failedCount:    true,
        createdAt:      true,
      },
    });

    if (existing) {
      return { ...existing, alreadyExisted: true };
    }

    // ── Resolve recipients ─────────────────────────────────────────────────
    const recipients = await this.resolveRecipients(dto);

    if (recipients.length === 0) {
      throw new BadRequestException('No eligible recipients found for the selected criteria.');
    }

    // ── Create the job record ──────────────────────────────────────────────
    const job = await this.prisma.emailJob.create({
      data: {
        id:              randomUUID(),
        idempotencyKey:  dto.idempotencyKey,
        subject:         dto.subject,
        body:            dto.body,         // stored for retry; never logged
        status:          'PENDING',
        totalRecipients: recipients.length,
        createdById:     caller.id,
        deliveries: {
          create: recipients.map((r) => ({
            id:             randomUUID(),
            recipientEmail: r.email,
            recipientId:    r.id ?? null,
            status:         'PENDING',
          })),
        },
      },
      select: {
        id:             true,
        status:         true,
        totalRecipients: true,
        sentCount:      true,
        failedCount:    true,
        createdAt:      true,
      },
    });

    // ── Audit: log subject + count but NOT the body ────────────────────────
    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'CREATE_EMAIL_JOB',
      entity:    'EmailJob',
      entityId:  job.id,
      metadata:  {
        subject:         dto.subject,
        recipientMode:   dto.recipientMode,
        totalRecipients: recipients.length,
        dryRun:          this.smtp.isDryRun,
        // body is deliberately omitted
      },
    });

    // ── Kick off background delivery (non-blocking) ────────────────────────
    setImmediate(() => void this.processJob(job.id));

    return { ...job, alreadyExisted: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Job status & retry
  // ═══════════════════════════════════════════════════════════════════════════

  /** Admin: get a single job with its per-recipient delivery records. */
  async getJob(jobId: string) {
    const job = await this.prisma.emailJob.findUnique({
      where:  { id: jobId },
      select: {
        id:              true,
        idempotencyKey:  true,
        subject:         true,
        // body is NOT returned — avoid leaking message content in responses
        status:          true,
        totalRecipients: true,
        sentCount:       true,
        failedCount:     true,
        completedAt:     true,
        createdAt:       true,
        createdBy: { select: { id: true, username: true } },
        deliveries: {
          select: {
            id:             true,
            recipientEmail: true,
            recipientId:    true,
            status:         true,
            messageId:      true,
            errorMessage:   true,
            attemptedAt:    true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!job) throw new NotFoundException('Email job not found.');
    return job;
  }

  /** Admin: list all jobs (no bodies returned). */
  async listJobs() {
    return this.prisma.emailJob.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id:              true,
        subject:         true,
        status:          true,
        totalRecipients: true,
        sentCount:       true,
        failedCount:     true,
        completedAt:     true,
        createdAt:       true,
        createdBy: { select: { id: true, username: true } },
      },
    });
  }

  /**
   * Admin: retry all FAILED deliveries for an existing job.
   *
   * Safe: only processes records with status = FAILED.
   * SENT records are never touched — no duplicate sends.
   */
  async retryJob(jobId: string, caller: CallerCtx) {
    const job = await this.prisma.emailJob.findUnique({
      where:  { id: jobId },
      select: { id: true, status: true, subject: true, body: true, failedCount: true },
    });

    if (!job) throw new NotFoundException('Email job not found.');

    if (job.failedCount === 0) {
      throw new BadRequestException('This job has no failed deliveries to retry.');
    }

    // Reset failed deliveries to PENDING.
    await this.prisma.emailDelivery.updateMany({
      where: { jobId, status: 'FAILED' },
      data:  { status: 'PENDING', errorMessage: null, attemptedAt: null },
    });

    await this.prisma.emailJob.update({
      where: { id: jobId },
      data:  { status: 'PENDING' },
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'RETRY_EMAIL_JOB',
      entity:    'EmailJob',
      entityId:  jobId,
      metadata:  { subject: job.subject, failedCount: job.failedCount },
    });

    setImmediate(() => void this.processJob(jobId));

    return { message: 'Retry enqueued.', jobId };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /** Resolve the list of {email, id} recipients based on the DTO mode. */
  private async resolveRecipients(
    dto: SendEmailDto,
  ): Promise<Array<{ email: string; id: string }>> {
    const select = { id: true, email: true };

    switch (dto.recipientMode) {
      case RecipientMode.EXPLICIT: {
        if (!dto.recipientUserIds?.length) return [];
        const users = await this.prisma.user.findMany({
          where:  { id: { in: dto.recipientUserIds } },
          select,
        });
        // Report any IDs that didn't resolve.
        const found    = new Set(users.map((u) => u.id));
        const missing  = dto.recipientUserIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw new BadRequestException(
            `${missing.length} recipient ID(s) not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}.`,
          );
        }
        return users;
      }

      case RecipientMode.ROLE: {
        if (!dto.recipientRole) return [];
        return this.prisma.user.findMany({
          where:  { role: dto.recipientRole as any },
          select,
        });
      }

      case RecipientMode.SCHOOL: {
        if (!dto.recipientSchoolId) return [];
        const school = await this.prisma.school.findUnique({
          where: { id: dto.recipientSchoolId },
        });
        if (!school) {
          throw new NotFoundException(`School ${dto.recipientSchoolId} not found.`);
        }
        return this.prisma.user.findMany({
          where:  { role: 'STUDENT', schoolId: dto.recipientSchoolId },
          select,
        });
      }

      case RecipientMode.ALL:
        return this.prisma.user.findMany({ select });

      default:
        return [];
    }
  }

  /**
   * Background delivery loop.
   *
   * - Runs fully asynchronously after the HTTP response is sent.
   * - Processes recipients in batches to avoid holding a huge connection.
   * - Writes SENT / FAILED status per delivery — never re-sends a SENT record.
   * - Updates job sentCount / failedCount atomically per batch.
   * - Marks the job COMPLETED / PARTIAL_FAILURE / FAILED when done.
   */
  private async processJob(jobId: string): Promise<void> {
    try {
      // Mark IN_PROGRESS (idempotent — safe to call on retry).
      await this.prisma.emailJob.update({
        where: { id: jobId },
        data:  { status: 'IN_PROGRESS' },
      });

      // Fetch the job body (needed for sending).
      const job = await this.prisma.emailJob.findUnique({
        where:  { id: jobId },
        select: { subject: true, body: true },
      });

      if (!job) return;

      // Process in batches of batchSize.
      let offset = 0;
      const batchSize = this.smtp.batchSize;

      while (true) {
        const pending = await this.prisma.emailDelivery.findMany({
          where:  { jobId, status: 'PENDING' },
          select: { id: true, recipientEmail: true },
          skip:   offset,
          take:   batchSize,
        });

        if (pending.length === 0) break;

        // Send each recipient in the batch concurrently within the batch.
        await Promise.all(
          pending.map(async (delivery) => {
            const result = await this.smtp.sendOne(
              delivery.recipientEmail,
              job.subject,
              job.body,
            );

            await this.prisma.emailDelivery.update({
              where: { id: delivery.id },
              data:  {
                status:       result.accepted ? 'SENT' : 'FAILED',
                messageId:    result.messageId,
                errorMessage: result.error,
                attemptedAt:  new Date(),
              },
            });

            // Increment the appropriate counter on the job.
            await this.prisma.emailJob.update({
              where: { id: jobId },
              data: result.accepted
                ? { sentCount:   { increment: 1 } }
                : { failedCount: { increment: 1 } },
            });
          }),
        );

        // If this was a full batch there may be more — advance offset.
        if (pending.length < batchSize) break;
        offset += batchSize;
      }

      // Determine final status.
      const final = await this.prisma.emailJob.findUnique({
        where:  { id: jobId },
        select: { sentCount: true, failedCount: true, totalRecipients: true },
      });

      let finalStatus: 'COMPLETED' | 'PARTIAL_FAILURE' | 'FAILED' = 'COMPLETED';
      if (final) {
        if (final.failedCount === final.totalRecipients) {
          finalStatus = 'FAILED';
        } else if (final.failedCount > 0) {
          finalStatus = 'PARTIAL_FAILURE';
        }
      }

      await this.prisma.emailJob.update({
        where: { id: jobId },
        data:  { status: finalStatus, completedAt: new Date() },
      });

      this.logger.log(
        `EmailJob ${jobId} ${finalStatus}: ` +
        `${final?.sentCount ?? 0} sent, ${final?.failedCount ?? 0} failed.`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`EmailJob ${jobId} processing error: ${message}`);
      await this.prisma.emailJob.update({
        where: { id: jobId },
        data:  { status: 'FAILED', completedAt: new Date() },
      }).catch(() => void 0);
    }
  }
}
