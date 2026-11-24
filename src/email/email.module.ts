import { Module } from '@nestjs/common';
import { EmailController } from './email.controller.js';
import { EmailService } from './email.service.js';
import { EmailWorker } from './email.worker.js';
import { MailerService } from './mailer.service.js';
import { EmailBudgetService } from './email-budget.service.js';

@Module({
  controllers: [EmailController],
  // Prisma and Audit come from @Global() modules.
  providers:   [EmailService, EmailWorker, MailerService, EmailBudgetService],
  // EmailWorker: subscriber mailings refresh their e-mail job's counters (src/subscribers).
  exports:     [EmailService, MailerService, EmailWorker, EmailBudgetService],
})
export class EmailModule {}
