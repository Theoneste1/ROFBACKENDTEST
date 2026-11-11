import { Module } from '@nestjs/common';
import { AdminSchoolsController } from './admin-schools.controller.js';
import { AdminSchoolsService } from './admin-schools.service.js';
import { SchoolsController } from './schools.controller.js';
import { SchoolsService } from './schools.service.js';

@Module({
  controllers: [SchoolsController, AdminSchoolsController],
  providers:   [SchoolsService, AdminSchoolsService],
  exports:     [SchoolsService],
})
export class SchoolsModule {}
