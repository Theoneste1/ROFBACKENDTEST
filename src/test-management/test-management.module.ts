import { Module } from '@nestjs/common';

import { TestFileKindPipe, TestMarkersController, TestsController } from './tests.controller.js';
import { TestDeadlineService } from './test-deadline.service.js';
import { TestExtensionsService } from './test-extensions.service.js';
import { TestMarkersService } from './test-markers.service.js';
import {
  AdminTestExtensionsController, AdminTestSubmissionsController, MyTestsController, TeacherTestsController,
} from './test-submissions.controller.js';
import { TestSubmissionsService } from './test-submissions.service.js';
import { TestsService } from './tests.service.js';

/**
 * Test Management (WS3). Phase 1: tests, questions, paper and marking guide, marker authorisations. Phase 2: the deadline
 * service (database time), extensions, student and teacher submissions with every version, submission tracking.
 */
@Module({
  controllers: [
    TestsController, TestMarkersController,
    AdminTestExtensionsController, AdminTestSubmissionsController, MyTestsController, TeacherTestsController,
  ],
  providers: [TestsService, TestMarkersService, TestFileKindPipe, TestDeadlineService, TestExtensionsService, TestSubmissionsService],
})
export class TestManagementModule {}
