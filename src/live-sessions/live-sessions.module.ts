import { Module } from '@nestjs/common';
import { LiveSessionsController } from './live-sessions.controller.js';
import { LiveSessionsService } from './live-sessions.service.js';

@Module({
  controllers: [LiveSessionsController],
  providers:   [LiveSessionsService],
  exports:     [LiveSessionsService],
})
export class LiveSessionsModule {}
