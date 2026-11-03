import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { Events } from '../notifications/events.js';
import { SettingsService } from '../settings/settings.service.js';

const HOUR_MS = 60 * 60 * 1000;

/**
 * AssignmentDeadlineReminderService
 *
 * Every 10 minutes, finds PUBLISHED assignments (in published courses) whose
 * deadline is within the reminder window (setting
 * notifications.deadlineReminderHours, default 24) and emits one AssignmentDeadlineApproaching
 * event each; NotificationListener reminds the students who have not submitted.
 *
 * `deadlineRemindedFor` records which deadline was reminded about, so each
 * deadline is reminded once — and a moved deadline (edit or reopen) gets a
 * fresh reminder. The claim is a single UPDATE … RETURNING, so several
 * instances never send the same reminder twice. Administrators can switch the
 * reminders off (notifications.deadlineRemindersEnabled).
 */
@Injectable()
export class AssignmentDeadlineReminderService {
  private readonly logger = new Logger(AssignmentDeadlineReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
    private readonly settings: SettingsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'assignment-deadline-reminders' })
  async run(): Promise<void> {
    if (this.config.get('WORKERS_ENABLED') === 'false') return;
    try {
      const count = await this.sendDue();
      if (count > 0) this.logger.log(`Sent deadline reminders for ${count} assignment(s).`);
    } catch (err) {
      this.logger.error(`Deadline reminders failed: ${(err as Error).message}`);
    }
  }

  /** Claim every assignment due soon and not yet reminded; returns how many. */
  async sendDue(now = new Date()): Promise<number> {
    if (!(await this.settings.get('notifications.deadlineRemindersEnabled'))) return 0;
    const until = new Date(now.getTime() + (await this.settings.get('notifications.deadlineReminderHours')) * HOUR_MS);
    const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "Assignment" a
         SET "deadlineRemindedFor" = a."deadline"
       WHERE a."status" = 'PUBLISHED'
         AND a."deadline" > ${now} AND a."deadline" <= ${until}
         AND a."deadlineRemindedFor" IS DISTINCT FROM a."deadline"
         AND EXISTS (SELECT 1 FROM "Course" c WHERE c."id" = a."courseId" AND c."status" = 'PUBLISHED')
      RETURNING a."id"`;
    for (const { id } of claimed) this.events.emit(Events.AssignmentDeadlineApproaching, { assignmentId: id });
    return claimed.length;
  }
}
