import { Module } from '@nestjs/common';
import { AssignmentsController, MyAssignmentsController } from './assignments.controller.js';
import { AssignmentsService } from './assignments.service.js';
import { AssignmentCloserService } from './assignment-closer.service.js';

@Module({
  controllers: [AssignmentsController, MyAssignmentsController],
  // Prisma, Audit, Access and Storage come from @Global() modules.
  providers:   [AssignmentsService, AssignmentCloserService],
  exports:     [AssignmentsService, AssignmentCloserService],
})
export class AssignmentsModule {}
