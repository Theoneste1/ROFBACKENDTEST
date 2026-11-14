import { Global, Module } from '@nestjs/common';

import { EmailModule } from '../email/email.module.js';
import { DecisionNotificationsController } from './decision-notifications.controller.js';
import { DecisionNotificationsService } from './decision-notifications.service.js';

/**
 * Decision notifications (owner-approved): the one outbox for school verification, teacher and coach
 * approval and permission grants. Global, so the deciding services enqueue inside their transactions.
 */
@Global()
@Module({
  imports:     [EmailModule],
  controllers: [DecisionNotificationsController],
  providers:   [DecisionNotificationsService],
  exports:     [DecisionNotificationsService],
})
export class DecisionNotificationsModule {}
