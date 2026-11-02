import { Module } from '@nestjs/common';
import { SubmissionsController } from './submissions.controller.js';
import { SubmissionsService } from './submissions.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [SubmissionsController],
  // AuditService is provided by the @Global() AuditModule.
  providers:   [SubmissionsService],
  exports:     [SubmissionsService],
})
export class SubmissionsModule {}
