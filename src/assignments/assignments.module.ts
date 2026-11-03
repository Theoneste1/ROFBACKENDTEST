import { Module } from '@nestjs/common';
import { AssignmentsController, MyAssignmentsController } from './assignments.controller.js';
import { AssignmentsService } from './assignments.service.js';
import { AssignmentCloserService } from './assignment-closer.service.js';
import { AssignmentDeadlineReminderService } from './assignment-deadline-reminder.service.js';

@Module({
  controllers: [AssignmentsController, MyAssignmentsController],
  // Prisma, Audit, Access and Storage come from @Global() modules.
  providers:   [AssignmentsService, AssignmentCloserService, AssignmentDeadlineReminderService],
  exports:     [AssignmentsService, AssignmentCloserService, AssignmentDeadlineReminderService],
})
export class AssignmentsModule {}
