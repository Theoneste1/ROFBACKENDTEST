import { Module } from '@nestjs/common';
import { MentorRequestsController } from './mentor-requests.controller.js';
import { MentorRequestsService } from './mentor-requests.service.js';

@Module({
  controllers: [MentorRequestsController],
  // AuditService is provided by the @Global() AuditModule.
  providers:   [MentorRequestsService],
})
export class MentorRequestsModule {}
