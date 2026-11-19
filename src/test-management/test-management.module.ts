import { Module } from '@nestjs/common';

import { TestFileKindPipe, TestMarkersController, TestsController } from './tests.controller.js';
import { TestMarkersService } from './test-markers.service.js';
import { TestsService } from './tests.service.js';

/** Test Management (WS3, Phase 1): tests, questions, paper and marking guide, marker authorisations. */
@Module({
  controllers: [TestsController, TestMarkersController],
  providers:   [TestsService, TestMarkersService, TestFileKindPipe],
})
export class TestManagementModule {}
