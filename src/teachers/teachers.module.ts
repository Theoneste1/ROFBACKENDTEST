import { Module } from '@nestjs/common';

import { PermissionOverridesModule } from '../permission-overrides/permission-overrides.module.js';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { TeacherDelegationsController, TeacherSchoolsController, TeacherStudentsController } from './teachers.controller.js';
import { TeacherSchoolsService } from './teacher-schools.service.js';
import { TeacherStudentsService } from './teacher-students.service.js';

/** Teachers (P1-11): school assignments, delegations and the teacher's school-scoped views. */
@Module({
  imports:     [PermissionOverridesModule, SubmissionsModule],
  controllers: [TeacherSchoolsController, TeacherDelegationsController, TeacherStudentsController],
  providers:   [TeacherSchoolsService, TeacherStudentsService],
})
export class TeachersModule {}
