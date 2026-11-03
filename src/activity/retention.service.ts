/**
 * Data-retention jobs (nightly). The policy is documented in docs/DATABASE.md.
 *
 *   ActivityLog              older than 400 days        → deleted
 *   Notification (read)      older than 180 days        → deleted
 *   EmailDelivery (SENT)     older than 90 days         → body/subject cleared
 *                                                         (delivery record kept)
 *
 * Academic records (submissions, reviews, results, audit log) are never
 * purged automatically.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from '../prisma/prisma.service.js';

const DAY = 24 * 60 * 60 * 1000;
export const RETENTION = {
  activityDays:          400,
  readNotificationDays:  180,
  sentEmailBodyDays:     90,
} as const;

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'data-retention' })
  async nightly() {
    if (this.config.get('WORKERS_ENABLED') === 'false') return;
    try {
      const result = await this.run();
      this.logger.log(`Retention: ${JSON.stringify(result)}`);
    } catch (err) {
      this.logger.error(`Retention job failed: ${(err as Error).message}`);
    }
  }

  async run(now = new Date()) {
    const [activity, notifications, emails] = await this.prisma.$transaction([
      this.prisma.activityLog.deleteMany({
        where: { createdAt: { lt: new Date(now.getTime() - RETENTION.activityDays * DAY) } },
      }),
      this.prisma.notification.deleteMany({
        where: { readAt: { lt: new Date(now.getTime() - RETENTION.readNotificationDays * DAY) } },
      }),
      this.prisma.emailDelivery.updateMany({
        where: {
          status:    'SENT',
          createdAt: { lt: new Date(now.getTime() - RETENTION.sentEmailBodyDays * DAY) },
          body:      { not: null },
        },
        data: { body: null, subject: null },
      }),
    ]);
    return {
      activityDeleted:      activity.count,
      notificationsDeleted: notifications.count,
      emailBodiesCleared:   emails.count,
    };
  }
}
