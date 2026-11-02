import { Module } from '@nestjs/common';
import {
  AdminPointsController,
  AssignmentResultsController,
  MentorReviewsController,
  MySubmissionsController,
  SubmissionsController,
} from './submissions.controller.js';
import { SubmissionsService } from './submissions.service.js';

@Module({
  controllers: [
    SubmissionsController,
    AssignmentResultsController,
    MySubmissionsController,
    MentorReviewsController,
    AdminPointsController,
  ],
  // Prisma, Audit, Access, Storage and Settings come from @Global() modules.
  providers: [SubmissionsService],
  exports:   [SubmissionsService],
})
export class SubmissionsModule {}
