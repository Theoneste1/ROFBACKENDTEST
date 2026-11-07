/**
 * Account e-mails that are not tied to a one-time link: welcome, approval and
 * the "your password was changed" security notice. Queued in the outbox like
 * every other e-mail. They never contain passwords or tokens.
 */
import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationsService } from './notifications.service.js';

@Injectable()
export class AccountEmailsService {
  private readonly logger = new Logger(AccountEmailsService.name);

  constructor(
    private readonly prisma:        PrismaService,
    private readonly settings:      SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The account is ready (registration without e-mail confirmation, or activation). */
  async welcome(userId: string) {
    await this.safe('welcome', async () => {
      const user = await this.user(userId);
      if (!user) return;
      const platform = await this.settings.get('platform.name');
      const pending  = !user.isApproved;
      await this.notifications.queueEmail(
        user.email,
        `Welcome to ${platform}`,
        `Welcome to ${platform}, the learning platform of the Rwanda Olympiad Foundation. ` +
          `Your account has been created with the username "${user.username}".\n\n` +
          (pending
            ? 'An administrator will review your registration. We will e-mail you as soon as it is approved, and you can then log in.'
            : 'You can now log in to follow your courses, submit assignments and see your results.'),
        {
          firstName: user.firstName, recipientId: user.id, heading: `Welcome, ${user.firstName}!`,
          ...(!pending && { link: '/login', actionLabel: 'Log in' }),
        },
      );
    });
  }

  /** An administrator approved a pending registration. */
  async approved(userId: string) {
    await this.safe('approval', async () => {
      const user = await this.user(userId);
      if (!user?.activatedAt) return; // still has to confirm their e-mail first
      await this.notifications.queueEmail(
        user.email,
        'Your account has been approved',
        `Good news: your registration has been approved. You can now log in with the username "${user.username}".`,
        { firstName: user.firstName, recipientId: user.id, link: '/login', actionLabel: 'Log in' },
      );
    });
  }

  /** Security notice after a password reset or change. */
  async passwordChanged(userId: string) {
    await this.safe('password changed', async () => {
      const user = await this.user(userId);
      if (!user) return;
      await this.notifications.queueEmail(
        user.email,
        'Your password was changed',
        `The password of your account "${user.username}" was just changed, and you have been signed out on your other devices.\n\n` +
          'If you made this change, there is nothing else to do.',
        {
          firstName: user.firstName, recipientId: user.id, link: '/forgot-password', actionLabel: 'I did not do this — reset my password',
          note: 'If you did not change your password, reset it now with the button above and tell us by replying to this e-mail.',
        },
      );
    });
  }

  private user(id: string) {
    return this.prisma.user.findUnique({
      where:  { id },
      select: { id: true, email: true, firstName: true, username: true, isApproved: true, activatedAt: true, isActive: true },
    }).then((u) => (u?.isActive ? u : null));
  }

  /** An e-mail that cannot be queued must never undo the action that triggered it. */
  private async safe(what: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Could not queue the ${what} e-mail: ${(err as Error).message}`);
    }
  }
}
