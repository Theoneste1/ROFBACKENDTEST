import { Module } from '@nestjs/common';
import { DiscussionsController } from './discussions.controller.js';
import { DiscussionsService } from './discussions.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [DiscussionsController],
  // AuditService is provided by the @Global() AuditModule.
  providers:   [DiscussionsService],
  exports:     [DiscussionsService],
})
export class DiscussionsModule {}
