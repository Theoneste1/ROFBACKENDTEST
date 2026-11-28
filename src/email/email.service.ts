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
import { seesSuperAdmins, visibleUsersWhere } from '../common/access/super-admin-privacy.js';
import { Prisma, type EmailDeliveryStatus } from '../generated/prisma/client.js';
import { MailerService } from './mailer.service.js';
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
const REACHABLE_ACCOUNTS: Prisma.UserWhereInput = { isActive: true, isApproved: true };

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
    private readonly mailer:  MailerService,
    private readonly audit:   AuditService,
    private readonly worker:  EmailWorker,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // User search / filter (admin view with email)
  // ═══════════════════════════════════════════════════════════════════════════

  async listUsers(query: ListUsersDto, viewer: CallerCtx) {
    const { page, limit, skip, take } = pageArgs(query);

    // Super Administrator privacy (owner 2026-11-28): only a Super Administrator sees Super Administrators here.
    const where: Prisma.UserWhereInput = {
      AND: [visibleUsersWhere(viewer)],
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

    const recipients = await this.resolveRecipients(dto, caller);
    if (recipients.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_RECIPIENTS', 'Nobody matches the recipients you chose. Change the roles, levels or schools, then try again.');
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
            dryRun:          this.mailer.isDryRun,
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

    return { ...job, dryRun: this.mailer.isDryRun, alreadyExisted: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Job status & retry
  // ═══════════════════════════════════════════════════════════════════════════

  async getJob(jobId: string, viewer: CallerCtx) {
    const job = await this.prisma.emailJob.findFirst({
      where:  { AND: [{ id: jobId }, await this.visibleJobsWhere(viewer)] },
      select: { ...JOB_SUMMARY, idempotencyKey: true },
    });
    if (!job) throw new NotFoundException('Email job not found.');
    return job;
  }

  async listDeliveries(jobId: string, q: PaginationQueryDto & { status?: EmailDeliveryStatus }, viewer: CallerCtx) {
    await this.getJob(jobId, viewer);
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.EmailDeliveryWhereInput = { jobId, ...(q.status && { status: q.status }) };
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

  /** All deliveries (transactional and bulk), newest first, without bodies. */
  async listAllDeliveries(q: PaginationQueryDto & { status?: EmailDeliveryStatus; kind?: 'TRANSACTIONAL' | 'BULK' }, viewer: CallerCtx) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.EmailDeliveryWhereInput = {
      AND: [await this.visibleDeliveriesWhere(viewer)],
      ...(q.status && { status: q.status }),
      ...(q.kind === 'TRANSACTIONAL' && { jobId: null }),
      ...(q.kind === 'BULK' && { jobId: { not: null } }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailDelivery.findMany({
        where, skip, take,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true, jobId: true, recipientEmail: true, recipientId: true, subject: true, status: true,
          attempts: true, errorMessage: true, attemptedAt: true, createdAt: true,
        },
      }),
      this.prisma.emailDelivery.count({ where }),
    ]);
    return paginated(rows.map((r) => ({ ...r, kind: r.jobId ? 'BULK' : 'TRANSACTIONAL' })), total, page, limit);
  }

  /** Re-queue one FAILED delivery; its job's counters are refreshed. Conditional, so a double click re-queues once. */
  async retryDelivery(id: string, caller: CallerCtx) {
    const d = await this.prisma.emailDelivery.findFirst({
      where: { AND: [{ id }, await this.visibleDeliveriesWhere(caller)] }, select: { id: true, jobId: true, status: true, body: true, html: true },
    });
    if (!d) throw new NotFoundException('Delivery not found.');
    // One-time links (activation, password reset) are never kept: such an e-mail cannot be re-sent
    // as it was — the administrator sends a new link (resend invitation / password reset) instead.
    if (d.status === 'FAILED' && d.body === null && d.html === null) {
      throw new AppError(HttpStatus.CONFLICT, 'CONTENT_NOT_KEPT',
        'This e-mail contained a one-time link and was not kept. Send a new invitation or password-reset link instead.');
    }
    const { count } = await this.prisma.emailDelivery.updateMany({
      where: { id, status: 'FAILED' },
      data:  { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), errorMessage: null, lockedAt: null },
    });
    if (count === 0) throw invalidState(`Only FAILED deliveries can be retried. Current: "${d.status}".`);
    if (d.jobId) await this.worker.refreshJob(d.jobId);
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'RETRY_EMAIL_DELIVERY', entity: 'EmailDelivery', entityId: id, metadata: { jobId: d.jobId },
    });
    return { message: 'Retry enqueued.', deliveryId: id };
  }

  async listJobs(q: PaginationQueryDto, viewer: CallerCtx) {
    const { page, limit, skip, take } = pageArgs(q);
    const where = await this.visibleJobsWhere(viewer);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.emailJob.findMany({ where, orderBy: { createdAt: 'desc' }, select: JOB_SUMMARY, skip, take }),
      this.prisma.emailJob.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /**
   * Re-queue FAILED deliveries of a finished job. SENT deliveries are never
   * touched, so nobody receives the message twice.
   */
  async retryJob(jobId: string, caller: CallerCtx) {
    const job = await this.getJob(jobId, caller);
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

  // ─── Super Administrator privacy (owner 2026-11-28) ─────────────────────────
  // Anyone but a Super Administrator never sees an e-mail addressed to a Super Administrator (by account or by address),
  // nor a bulk job that has such a delivery; and never resolves a Super Administrator as a recipient.

  /** The Super Administrators' ids and addresses, or null when the viewer sees them (read fresh: a handful of rows). */
  private async hiddenRecipients(viewer: CallerCtx): Promise<{ ids: string[]; emails: string[] } | null> {
    if (seesSuperAdmins(viewer)) return null;
    const rows = await this.prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true, email: true } });
    return { ids: rows.map((r) => r.id), emails: rows.map((r) => r.email).filter((e): e is string => !!e) };
  }

  private addressedTo(h: { ids: string[]; emails: string[] }): Prisma.EmailDeliveryWhereInput[] {
    return [
      ...(h.ids.length ? [{ recipientId: { in: h.ids } }] : []),
      ...h.emails.map((e) => ({ recipientEmail: { equals: e, mode: 'insensitive' as const } })),
    ];
  }

  private async visibleDeliveriesWhere(viewer: CallerCtx): Promise<Prisma.EmailDeliveryWhereInput> {
    const h = await this.hiddenRecipients(viewer);
    if (!h) return {};
    // recipientId is nullable: written so that a transactional e-mail without an account id is kept.
    return {
      AND: [
        ...(h.ids.length ? [{ OR: [{ recipientId: null }, { recipientId: { notIn: h.ids } }] }] : []),
        ...h.emails.map((e) => ({ NOT: { recipientEmail: { equals: e, mode: 'insensitive' as const } } })),
      ],
    };
  }

  private async visibleJobsWhere(viewer: CallerCtx): Promise<Prisma.EmailJobWhereInput> {
    const h = await this.hiddenRecipients(viewer);
    if (!h) return {};
    const to = this.addressedTo(h);
    return to.length ? { deliveries: { none: { OR: to } } } : {};
  }

  private findByKey(idempotencyKey: string) {
    return this.prisma.emailJob.findUnique({ where: { idempotencyKey }, select: JOB_SUMMARY });
  }

  /** Recipients the caller may address: a Super Administrator never for anyone else (an id of one is "not found"). */
  private async resolveRecipients(dto: SendEmailDto, caller: CallerCtx): Promise<Array<{ email: string; id: string }>> {
    const select = { id: true, email: true };
    const REACHABLE: Prisma.UserWhereInput = { ...REACHABLE_ACCOUNTS, AND: [visibleUsersWhere(caller)] };

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
            `${missing.length} of the chosen recipients no longer exist or are not active. Remove them from the list, then send again.`,
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
