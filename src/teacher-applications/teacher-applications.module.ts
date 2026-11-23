import { SchoolsModule } from '../schools/schools.module.js';
import { Module } from '@nestjs/common';
import { TeacherApplicationBulkHandler } from './bulk/teacher-application-bulk.handler.js';

import { AuthModule } from '../auth/auth.module.js';
import { AdminTeacherApplicationsController, TeacherRegistrationController } from './teacher-applications.controller.js';
import { TeacherApplicationsService } from './teacher-applications.service.js';

/** Teacher self-registration (owner-approved): public applications reviewed by Administrators. */
@Module({
  imports:     [AuthModule, SchoolsModule],
  controllers: [TeacherRegistrationController, AdminTeacherApplicationsController],
  providers:   [TeacherApplicationsService, TeacherApplicationBulkHandler],
})
export class TeacherApplicationsModule {}
