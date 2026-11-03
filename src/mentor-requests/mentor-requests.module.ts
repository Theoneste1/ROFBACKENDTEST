import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MentorRequestsController } from './mentor-requests.controller.js';
import { MentorRequestsService } from './mentor-requests.service.js';

@Module({
  imports:     [AuthModule],
  controllers: [MentorRequestsController],
  // AuditService is provided by the @Global() AuditModule.
  providers:   [MentorRequestsService],
})
export class MentorRequestsModule {}
