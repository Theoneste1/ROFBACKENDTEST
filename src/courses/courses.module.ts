import { Module } from '@nestjs/common';
import { AdminCoursesController, CoursesController, MyCoursesController } from './courses.controller.js';
import { CoursesService } from './courses.service.js';
import { CourseResourcesService } from './course-resources.service.js';

@Module({
  controllers: [CoursesController, AdminCoursesController, MyCoursesController],
  // Prisma, Audit, Access and Storage come from @Global() modules.
  providers:   [CoursesService, CourseResourcesService],
  exports:     [CoursesService, CourseResourcesService],
})
export class CoursesModule {}
