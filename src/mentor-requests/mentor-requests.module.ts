import { Module } from '@nestjs/common';
import { MentorRequestsController } from './mentor-requests.controller.js';
import { MentorRequestsService } from './mentor-requests.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [MentorRequestsController],
  // AuditService is provided by the @Global() AuditModule — no re-provision needed.
  providers:   [MentorRequestsService],
})
export class MentorRequestsModule {}
