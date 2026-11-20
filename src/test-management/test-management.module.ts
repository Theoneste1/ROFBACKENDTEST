import { Module } from '@nestjs/common';

import { TestFileKindPipe, TestMarkersController, TestsController } from './tests.controller.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { TestExtensionsService } from './test-extensions.service.js';
import { TestMarkersService } from './test-markers.service.js';
import {
  AdminTestExtensionsController, AdminTestSubmissionsController, MyTestsController, TeacherTestsController,
} from './test-submissions.controller.js';
import { TestSubmissionsService } from './test-submissions.service.js';
import { AdminTestMarkingController, MarkingController } from './test-marking.controller.js';
import { TestMarkerService } from './test-marker.service.js';
import { TestMarkingService } from './test-marking.service.js';
import { TestsService } from './tests.service.js';

/**
 * Test Management (WS3). Phase 1: tests, questions, paper and marking guide, marker authorisations. Phase 2: the deadline
 * service (database time), extensions, student and teacher submissions with every version, submission tracking. Phase 3:
 * distribution to authorised coaches, blind marking, second marking, review, approval and locking, the mark-change log.
 */
@Module({
  controllers: [
    TestsController, TestMarkersController,
    AdminTestExtensionsController, AdminTestSubmissionsController, MyTestsController, TeacherTestsController,
    AdminTestMarkingController, MarkingController,
  ],
  providers: [
    TestsService, TestMarkersService, TestFileKindPipe, TestDeadlineService, TestExtensionsService, TestSubmissionsService,
    TestMarkingService, TestMarkerService,
  ],
})
export class TestManagementModule {}
