/**
 * EmailWorker — drains the EmailDelivery outbox.
 *
 * Every 10 seconds it claims a batch of due PENDING deliveries with
 * `FOR UPDATE SKIP LOCKED`, so several API instances can run it at once
 * without sending anything twice. Each claim sets `lockedAt`; a claim older
 * than 5 minutes (crashed worker) is picked up again.
 *
 * Failures are retried with exponential backoff (1, 2, 4, 8 minutes) and
 * marked FAILED after MAX_ATTEMPTS. Bulk-job counters are recomputed from the
 * delivery rows (never incremented), so retries cannot double-count.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service.js';
import { SmtpService } from './smtp.service.js';

export const MAX_ATTEMPTS = 5;

interface ClaimedDelivery {
  id:             string;
  jobId:          string | null;
  recipientEmail: string;
  subject:        string | null;
  body:           string | null;
  attempts:       number;
}

@Injectable()
export class EmailWorker {
  private readonly logger = new Logger(EmailWorker.name);
  private running = false;

  constructor(
    private readonly prisma:  PrismaService,
    private readonly smtp:    SmtpService,
    private readonly config:  ConfigService,
  ) {}

  @Interval('email-outbox', 10_000)
  async tick() {
    if (this.config.get('WORKERS_ENABLED') === 'false' || this.running) return;
    this.running = true;
    try {
      // Keep going while full batches are found (bounded per tick).
      for (let i = 0; i < 20; i++) {
        const processed = await this.processBatch();
        if (processed < this.smtp.batchSize) break;
      }
    } catch (err) {
      this.logger.error(`Outbox processing failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Claim and send one batch. Returns the number of deliveries processed. */
  async processBatch(): Promise<number> {
    const claimed = await this.prisma.$queryRaw<ClaimedDelivery[]>`
      UPDATE "EmailDelivery" d
      SET "lockedAt" = NOW(), "attempts" = d."attempts" + 1
      WHERE d."id" IN (
        SELECT "id" FROM "EmailDelivery"
        WHERE "status" = 'PENDING'
          AND "nextAttemptAt" <= NOW()
          AND ("lockedAt" IS NULL OR "lockedAt" < NOW() - INTERVAL '5 minutes')
        ORDER BY "createdAt" ASC
        LIMIT ${this.smtp.batchSize}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING d."id", d."jobId", d."recipientEmail", d."subject", d."body", d."attempts"`;

    if (claimed.length === 0) return 0;

    // Bulk-job deliveries take subject/body from their job.
    const jobIds = [...new Set(claimed.map((c) => c.jobId).filter((id): id is string => !!id))];
    const jobs = new Map(
      (await this.prisma.emailJob.findMany({
        where:  { id: { in: jobIds } },
        select: { id: true, subject: true, body: true },
      })).map((j) => [j.id, j]),
    );

    // Bounded concurrency: the transporter pools connections.
    const CONCURRENCY = 5;
    for (let i = 0; i < claimed.length; i += CONCURRENCY) {
      await Promise.all(claimed.slice(i, i + CONCURRENCY).map((d) => this.deliver(d, d.jobId ? jobs.get(d.jobId) : undefined)));
    }

    for (const jobId of jobIds) await this.refreshJob(jobId);
    return claimed.length;
  }

  private async deliver(d: ClaimedDelivery, job?: { subject: string; body: string }) {
    const subject = d.subject ?? job?.subject;
    const body    = d.body    ?? job?.body;

    if (!subject || !body) {
      await this.prisma.emailDelivery.update({
        where: { id: d.id },
        data:  { status: 'FAILED', errorMessage: 'Missing subject or body.', lockedAt: null, attemptedAt: new Date() },
      });
      return;
    }

    const result = await this.smtp.sendOne(d.recipientEmail, subject, body);

    if (result.accepted) {
      await this.prisma.emailDelivery.update({
        where: { id: d.id },
        data:  { status: 'SENT', messageId: result.messageId, errorMessage: null, lockedAt: null, attemptedAt: new Date() },
      });
      return;
    }

    const giveUp = d.attempts >= MAX_ATTEMPTS;
    const backoffMs = 60_000 * 2 ** (d.attempts - 1);
    await this.prisma.emailDelivery.update({
      where: { id: d.id },
      data: {
        status:        giveUp ? 'FAILED' : 'PENDING',
        errorMessage:  result.error?.slice(0, 1000),
        lockedAt:      null,
        attemptedAt:   new Date(),
        nextAttemptAt: new Date(Date.now() + backoffMs),
      },
    });
  }

  /** Recompute a bulk job's counters and status from its deliveries. */
  async refreshJob(jobId: string) {
    const groups = await this.prisma.emailDelivery.groupBy({
      by:     ['status'],
      where:  { jobId },
      _count: { _all: true },
    });
    const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const sent = count('SENT'), failed = count('FAILED'), pending = count('PENDING');

    const status =
      pending > 0          ? 'IN_PROGRESS' :
      failed === 0         ? 'COMPLETED'   :
      sent === 0           ? 'FAILED'      :
                             'PARTIAL_FAILURE';

    await this.prisma.emailJob.update({
      where: { id: jobId },
      data:  {
        sentCount:   sent,
        failedCount: failed,
        status,
        completedAt: pending === 0 ? new Date() : null,
      },
    });
  }
}
