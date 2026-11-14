import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { AdminTeacherApplicationsController, TeacherRegistrationController } from './teacher-applications.controller.js';
import { TeacherApplicationsService } from './teacher-applications.service.js';

/** Teacher self-registration (owner-approved): public applications reviewed by Administrators. */
@Module({
  imports:     [AuthModule],
  controllers: [TeacherRegistrationController, AdminTeacherApplicationsController],
  providers:   [TeacherApplicationsService],
})
export class TeacherApplicationsModule {}
