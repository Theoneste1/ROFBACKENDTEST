import { Module } from '@nestjs/common';
import { CoursesController } from './courses.controller.js';
import { CoursesService } from './courses.service.js';
import { CourseResourcesService } from './course-resources.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [CoursesController],
  // AuditService is provided by the @Global() AuditModule.
  providers:   [CoursesService, CourseResourcesService],
  exports:     [CoursesService, CourseResourcesService],
})
export class CoursesModule {}


