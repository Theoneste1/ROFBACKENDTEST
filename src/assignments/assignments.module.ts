import { Module } from '@nestjs/common';
import { AssignmentsController, MyAssignmentsController } from './assignments.controller.js';
import { AssignmentsService } from './assignments.service.js';
import { AssignmentCloserService } from './assignment-closer.service.js';
import { AssignmentBulkHandler } from './bulk/assignment-bulk.handler.js';

@Module({
  controllers: [AssignmentsController, MyAssignmentsController],
  // Prisma, Audit, Access and Storage come from @Global() modules.
  providers:   [AssignmentsService, AssignmentCloserService, AssignmentBulkHandler],
  exports:     [AssignmentsService, AssignmentCloserService],
})
export class AssignmentsModule {}
