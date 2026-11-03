import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * AssignmentCloserService
 *
 * Every five minutes, PUBLISHED assignments whose deadline has passed are
 * moved to CLOSED, unless they accept late submissions (those stay open until
 * an admin closes them). Each one gets a CLOSED history entry with no actor.
 *
 * The UPDATE … RETURNING runs in the same transaction as the history insert,
 * and only rows still PUBLISHED are touched, so it is safe to run alongside
 * admin actions and on several instances.
 */
@Injectable()
export class AssignmentCloserService {
  private readonly logger = new Logger(AssignmentCloserService.name);

  constructor(
    private readonly prisma:  PrismaService,
    private readonly config:  ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'assignment-deadline-close' })
  async run(): Promise<void> {
    if (this.config.get('WORKERS_ENABLED') === 'false') return;
    const count = await this.closeOverdue();
    if (count > 0) this.logger.log(`Closed ${count} assignment(s) whose deadline passed.`);
  }

  /** Close every overdue assignment; returns how many were closed. */
  async closeOverdue(now = new Date()): Promise<number> {
    return this.prisma.$transaction(async (tx) => {
      const closed = await tx.$queryRaw<{ id: string }[]>`
        UPDATE "Assignment"
           SET "status" = 'CLOSED', "closedAt" = ${now}, "updatedAt" = ${now}
         WHERE "status" = 'PUBLISHED' AND "deadline" < ${now} AND "allowLateSubmission" = false
        RETURNING "id"`;
      if (closed.length > 0) {
        await tx.assignmentEvent.createMany({
          data: closed.map(({ id }) => ({
            assignmentId: id, type: 'CLOSED' as const, fromStatus: 'PUBLISHED' as const, toStatus: 'CLOSED' as const,
            note: 'Deadline passed', createdAt: now,
          })),
        });
      }
      return closed.length;
    });
  }
}
