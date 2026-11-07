import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationListener } from './notification.listener.js';
import { AccountEmailsService } from './account-emails.service.js';

@Global()
@Module({
  controllers: [NotificationsController],
  providers:   [NotificationsService, NotificationListener, AccountEmailsService],
  exports:     [NotificationsService, AccountEmailsService],
})
export class NotificationsModule {}
