import { Module } from '@nestjs/common';
import { ContactMessagesController, PublicSiteController } from './public-site.controller.js';
import { PublicSiteService } from './public-site.service.js';

/** Public homepage data: statistics and the contact form (Settings, Notifications, Audit are global). */
@Module({
  controllers: [PublicSiteController, ContactMessagesController],
  providers:   [PublicSiteService],
})
export class PublicSiteModule {}
