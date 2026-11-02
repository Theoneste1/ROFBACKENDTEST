import { Module } from '@nestjs/common';
import { DiscussionsController } from './discussions.controller.js';
import { DiscussionsService } from './discussions.service.js';

@Module({
  controllers: [DiscussionsController],
  // Prisma, Audit and Access come from @Global() modules.
  providers:   [DiscussionsService],
  exports:     [DiscussionsService],
})
export class DiscussionsModule {}
