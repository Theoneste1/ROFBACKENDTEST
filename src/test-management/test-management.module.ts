import { Module } from '@nestjs/common';

import { TestFileKindPipe, TestMarkersController, TestsController } from './tests.controller.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { TestExtensionsService } from './test-extensions.service.js';
import { TestMarkersService } from './test-markers.service.js';
import {
  AdminTestExtensionsController, AdminTestSubmissionsController, AdminSubmissionSearchController, MyTestsController, TeacherTestsController,
} from './test-submissions.controller.js';
import { TestSubmissionsService } from './test-submissions.service.js';
import { SubmissionReassignmentService } from './submission-reassignment.service.js';
import { AdminTestMarkingController, MarkingController } from './test-marking.controller.js';
import { TestMarkerService } from './test-marker.service.js';
import { TestMarkingService } from './test-marking.service.js';
import { TestsService } from './tests.service.js';
import {
  AdminTestReportsController, AdminTestResultsController, MarkingDashboardController, MyTestResultsController, TeacherTestResultsController, CoachTestResultsController,
} from './test-results.controller.js';
import { TestResultViewsService } from './test-result-views.service.js';
import { TestResultsService } from './test-results.service.js';
import { AdminQuestionMarkingController, QuestionMarkingController } from './question/question-marking.controller.js';
import { QuestionMarkerService } from './question/question-marker.service.js';
import { QuestionMarkingService } from './question/question-marking.service.js';
import { QuestionSweepService } from './question/question-sweep.service.js';

/**
 * Test Management (WS3). Phase 1: tests, questions, paper and marking guide, marker authorisations. Phase 2: the deadline
 * service (database time), extensions, student and teacher submissions with every version, submission tracking. Phase 3:
 * distribution to authorised coaches, blind marking, second marking, review, approval and locking, the mark-change log.
 * Phase 4: publication (Administrator override), withdrawal on unlock (G6), results for students and teachers, internal
 * rankings, reports and the role dashboards.
 */
@Module({
  controllers: [
    TestsController, TestMarkersController,
    AdminTestExtensionsController, AdminTestSubmissionsController, AdminSubmissionSearchController, MyTestsController, TeacherTestsController,
    AdminTestMarkingController, MarkingController,
    AdminTestResultsController, AdminTestReportsController, MyTestResultsController, TeacherTestResultsController, CoachTestResultsController, MarkingDashboardController,
    QuestionMarkingController, AdminQuestionMarkingController,
  ],
  providers: [
    TestsService, TestMarkersService, TestFileKindPipe, TestDeadlineService, TestExtensionsService, TestSubmissionsService, SubmissionReassignmentService,
    TestMarkingService, TestMarkerService, TestResultsService, TestResultViewsService,
    QuestionMarkerService, QuestionMarkingService, QuestionSweepService,
  ],
})
export class TestManagementModule {}
