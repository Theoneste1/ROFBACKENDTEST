import { Module } from '@nestjs/common';

import { EmailModule } from '../email/email.module.js';
import { AdminSubscribersController, PublicSubscribersController } from './subscribers.controller.js';
import { SubscribersService } from './subscribers.service.js';
import { MailingsService } from './mailings.service.js';

/** News subscribers and mailings (owner 2026-11-23). Prisma, Settings and Audit are global; the outbox worker comes from EmailModule. */
@Module({
  imports: [EmailModule],
  controllers: [PublicSubscribersController, AdminSubscribersController],
  providers: [SubscribersService, MailingsService],
})
export class SubscribersModule {}
