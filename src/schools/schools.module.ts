import { Module } from '@nestjs/common';
import { AdminSchoolsController } from './admin-schools.controller.js';
import { AdminSchoolsService } from './admin-schools.service.js';
import { SchoolDirectoryDataService } from './directory/school-directory-data.service.js';
import { SchoolImportService } from './import/school-import.service.js';
import { SchoolSyncController } from './sync/school-sync.controller.js';
import { SchoolSyncService } from './sync/school-sync.service.js';
import { SchoolSyncApplyService } from './sync/review/school-sync-apply.service.js';
import { SchoolSyncReviewController } from './sync/review/school-sync-review.controller.js';
import { SchoolSyncReviewService } from './sync/review/school-sync-review.service.js';
import { SchoolsController } from './schools.controller.js';
import { SchoolsService } from './schools.service.js';

@Module({
  controllers: [SchoolsController, AdminSchoolsController, SchoolSyncController, SchoolSyncReviewController],
  providers:   [SchoolsService, AdminSchoolsService, SchoolDirectoryDataService, SchoolImportService, SchoolSyncService, SchoolSyncReviewService, SchoolSyncApplyService],
  exports:     [SchoolsService],
})
export class SchoolsModule {}
