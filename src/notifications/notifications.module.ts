import { Global, Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { NotificationListener } from './notification.listener.js';

@Global()
@Module({
  controllers: [NotificationsController],
  providers:   [NotificationsService, NotificationListener],
  exports:     [NotificationsService],
})
export class NotificationsModule {}
