import {
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../common/pagination.js';
import type { CallerCtx } from '../common/auth-user.js';
import { Prisma, type EmailDeliveryStatus } from '../generated/prisma/client.js';
import { SmtpService } from './smtp.service.js';
import { EmailWorker } from './email.worker.js';
import { SendEmailDto, RecipientMode } from './dto/send-email.dto.js';
import { ListUsersDto } from './dto/list-users.dto.js';

/** Fields returned in user-list responses (email included for admin use). */
const USER_LIST_SELECT = {
  id:          true,
  firstName:   true,
  lastName:    true,
  username:    true,
  email:       true,
  role:        true,
  gradeLevel:  true,
  isApproved:  true,
  isActive:    true,
  createdAt:   true,
  division: { select: { id: true, code: true, name: true } },
  school:   { select: { id: true, name: true, location: true } },
} as const;

const JOB_SUMMARY = {
  id:              true,
  subject:         true,
  status:          true,
  totalRecipients: true,
  sentCount:       true,
  failedCount:     true,
  completedAt:     true,
  createdAt:       true,
  createdBy: { select: { id: true, username: true } },
} as const;

/** Recipients are only ever active, approved accounts. */
const REACHABLE: Prisma.UserWhereInput = { isActive: true, isApproved: true };

const CHUNK = 1000;

/**
 * Admin bulk e-mail.
 *
 * Creating a job writes one EmailDelivery row per recipient to the outbox;
 * EmailWorker sends them in the background with retries. Message bodies are
 * stored for retry but never returned by the API or written to audit logs.
 */
@Injectable()
export class EmailService {
  constructor(
    private readonly prisma:  PrismaService,
    private readonly smtp:    SmtpService,
    private readonly audit:   AuditService,
    private readonly worker:  EmailWorker,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // User search / filter (admin view with email)
  // ═══════════════════════════════════════════════════════════════════════════

  async listUsers(query: ListUsersDto) {
    const { page, limit, skip, take } = pageArgs(query);

    const where: Prisma.UserWhereInput = {
      ...(query.role       && { role: query.role as Prisma.EnumRoleFilter['equals'] }),
      ...(query.schoolId   && { schoolId: query.schoolId }),
      ...(query.divisionId && { divisionId: query.divisionId }),
      ...(query.isApproved !== undefined && { isApproved: query.isApproved }),
      ...(query.search && {
        OR: [
          { firstName: { contains: query.search, mode: 'insensitive' } },
          { lastName:  { contains: query.search, mode: 'insensitive' } },
          { username:  { contains: query.search, mode: 'insensitive' } },
          { email:     { contains: query.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select:  USER_LIST_SELECT,
        orderBy: [{ role: 'asc' }, { lastName: 'asc' }, { firstName: 'asc' }],
        skip,
        take,
      }),
      this.prisma.user.count({ where }),
    ]);

    return paginated(users, total, page, limit);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Bulk email — create job (delivery happens in EmailWorker)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Re-submitting the same idempotencyKey returns the existing job without
   * sending anything again. Poll `GET /admin/email/jobs/:id` for progress.
   */
  async sendBulk(dto: SendEmailDto, caller: CallerCtx) {
    const existing = await this.findByKey(dto.idempotencyKey);
    if (existing) return { ...existing, alreadyExisted: true };

    const recipients = await this.resolveRecipients(dto);
    if (recipients.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_RECIPIENTS', 'No eligible recipients found for the selected criteria.');
    }

    let job;
    try {
      job = await this.prisma.$transaction(async (tx) => {
        const created = await tx.emailJob.create({
          data: {
            idempotencyKey:  dto.idempotencyKey,
            subject:         dto.subject,
            body:            dto.body,           // stored for retry; never logged
            status:          'PENDING',
            totalRecipients: recipients.length,
            createdById:     caller.id,
          },
          select: JOB_SUMMARY,
        });

        for (let i = 0; i < recipients.length; i += CHUNK) {
          await tx.emailDelivery.createMany({
            data: recipients.slice(i, i + CHUNK).map((r) => ({
              jobId:          created.id,
              recipientEmail: r.email,
              recipientId:    r.id,
            })),
          });
        }

        await this.audit.log({
          actorId: caller.id, actorRole: caller.role,
          action: 'CREATE_EMAIL_JOB', entity: 'EmailJob', entityId: created.id,
          metadata: {
            recipientMode:   dto.recipientMode,
            totalRecipients: recipients.length,
            dryRun:          this.smtp.isDryRun,
            // subject and body deliberately omitted
          },
        }, tx);

        return created;
      }, { timeout: 60_000 });
    } catch (err) {
      // Two identical requests raced: return the job the other one created.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const raced = await this.findByKey(dto.idempotencyKey);
        if (raced) return { ...raced, alreadyExisted: true };
      }
      throw err;
    }

    return { ...job, dryRun: this.smtp.isDryRun, alreadyExisted: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Job status & retry
  // ═══════════════════════════════════════════════════════════════════════════

  async getJob(jobId: string) {
    const job = await this.prisma.emailJob.findUnique({
      where:  { id: jobId },
      select: { ...JOB_SUMMARY, idempotencyKey: true },
    });
    if (!job) throw new NotFoundException('Email job not found.');
    return job;
  }

  async listDeliveries(jobId: string, q: PaginationQueryDto & { status?: EmailDeliveryStatus }) {
    await this.getJob(jobId);
    const { page, limit, skip, take } = pageArgs(q);
    const where = { jobId, ...(q.status && { status: q.status }) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailDelivery.findMany({
        where, skip, take,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, recipientEmail: true, recipientId: true, status: true,
          attempts: true, messageId: true, errorMessage: true, attemptedAt: true,
        },
      }),
      this.prisma.emailDelivery.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  async listJobs(q: PaginationQueryDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailJob.findMany({ orderBy: { createdAt: 'desc' }, select: JOB_SUMMARY, skip, take }),
      this.prisma.emailJob.count(),
    ]);
    return paginated(rows, total, page, limit);
  }

  /**
   * Re-queue FAILED deliveries of a finished job. SENT deliveries are never
   * touched, so nobody receives the message twice.
   */
  async retryJob(jobId: string, caller: CallerCtx) {
    const job = await this.getJob(jobId);
    if (job.status === 'PENDING' || job.status === 'IN_PROGRESS') {
      throw invalidState('This job is still being sent.');
    }

    const { count } = await this.prisma.emailDelivery.updateMany({
      where: { jobId, status: 'FAILED' },
      data:  { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), errorMessage: null, lockedAt: null },
    });
    if (count === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOTHING_TO_RETRY', 'This job has no failed deliveries to retry.');
    }

    await this.worker.refreshJob(jobId);

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'RETRY_EMAIL_JOB', entity: 'EmailJob', entityId: jobId, metadata: { requeued: count },
    });

    return { message: 'Retry enqueued.', jobId, requeued: count };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private findByKey(idempotencyKey: string) {
    return this.prisma.emailJob.findUnique({ where: { idempotencyKey }, select: JOB_SUMMARY });
  }

  private async resolveRecipients(dto: SendEmailDto): Promise<Array<{ email: string; id: string }>> {
    const select = { id: true, email: true };

    switch (dto.recipientMode) {
      case RecipientMode.EXPLICIT: {
        if (!dto.recipientUserIds?.length) return [];
        const users = await this.prisma.user.findMany({
          where: { id: { in: dto.recipientUserIds }, ...REACHABLE },
          select,
        });
        const found   = new Set(users.map((u) => u.id));
        const missing = dto.recipientUserIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          throw new AppError(
            HttpStatus.BAD_REQUEST,
            'RECIPIENTS_NOT_FOUND',
            `${missing.length} recipient(s) not found or not active.`,
            { userIds: missing.slice(0, 20) },
          );
        }
        return users;
      }

      case RecipientMode.ROLE:
        return this.prisma.user.findMany({
          where: { role: dto.recipientRole as Prisma.EnumRoleFilter['equals'], ...REACHABLE },
          select,
        });

      case RecipientMode.DIVISION: {
        const division = await this.prisma.division.findUnique({ where: { id: dto.recipientDivisionId! } });
        if (!division) throw new NotFoundException('Division not found.');
        return this.prisma.user.findMany({
          where: { role: 'STUDENT', divisionId: division.id, ...REACHABLE },
          select,
        });
      }

      case RecipientMode.SCHOOL: {
        const school = await this.prisma.school.findUnique({ where: { id: dto.recipientSchoolId! } });
        if (!school) throw new NotFoundException('School not found.');
        return this.prisma.user.findMany({
          where: { role: 'STUDENT', schoolId: school.id, ...REACHABLE },
          select,
        });
      }

      case RecipientMode.ALL:
        return this.prisma.user.findMany({ where: REACHABLE, select });

      default:
        return [];
    }
  }
}
