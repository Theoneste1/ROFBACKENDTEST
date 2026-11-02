import { Module } from '@nestjs/common';
import { MentorAssignmentsController, MyTeachingController } from './mentor-assignments.controller.js';
import { MentorAssignmentsService } from './mentor-assignments.service.js';

@Module({
  controllers: [MentorAssignmentsController, MyTeachingController],
  providers:   [MentorAssignmentsService],
  exports:     [MentorAssignmentsService],
})
export class MentorAssignmentsModule {}
