import { Module } from '@nestjs/common';
import { SchoolsController } from './schools.controller.js';
import { SchoolsService } from './schools.service.js';

@Module({
  controllers: [SchoolsController],
  providers:   [SchoolsService],
  exports:     [SchoolsService],
})
export class SchoolsModule {}
