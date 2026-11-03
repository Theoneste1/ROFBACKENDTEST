import { Global, Module } from '@nestjs/common';
import { AcademicYearsController, AdminAcademicYearsController } from './academic-years.controller.js';
import { AcademicYearsService } from './academic-years.service.js';

@Global()
@Module({
  controllers: [AcademicYearsController, AdminAcademicYearsController],
  providers:   [AcademicYearsService],
  exports:     [AcademicYearsService],
})
export class AcademicYearsModule {}
