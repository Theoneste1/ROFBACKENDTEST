import { Module } from '@nestjs/common';
import {
  AdminPointsController,
  AssignmentResultsController,
  MentorReviewsController,
  MySubmissionsController,
  SubmissionsController,
} from './submissions.controller.js';
import { MyResultsController, ResultHistoryController } from './results.controller.js';
import { SubmissionsService } from './submissions.service.js';
import { ResultsService } from './results.service.js';

@Module({
  controllers: [
    SubmissionsController,
    ResultHistoryController,
    AssignmentResultsController,
    MySubmissionsController,
    MyResultsController,
    MentorReviewsController,
    AdminPointsController,
  ],
  // Prisma, Audit, Access, Storage and Settings come from @Global() modules.
  providers: [SubmissionsService, ResultsService],
  exports:   [SubmissionsService, ResultsService],
})
export class SubmissionsModule {}
