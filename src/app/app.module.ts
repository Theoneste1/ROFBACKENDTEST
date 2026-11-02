import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';

import { AuthModule } from '../auth/auth.module.js';
import { UsersModule } from '../users/users.module.js';
import { SchoolsModule } from '../schools/schools.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { AssignmentsModule } from '../assignments/assignments.module.js';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { MentorRequestsModule } from '../mentor-requests/mentor-requests.module.js';
import { StudyGroupsModule } from '../study-groups/study-groups.module.js';
import { EmailModule } from '../email/email.module.js';
import { DiscussionsModule } from '../discussions/discussions.module.js';
import { AuditModule } from '../audit/audit.module.js';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal:    true,
      envFilePath: join(process.cwd(), '.env'),
    }),

    PrismaModule,

    // AuditModule is @Global — must come before modules that inject AuditService
    AuditModule,

    AuthModule,
    UsersModule,
    SchoolsModule,
    CoursesModule,
    LeaderboardModule,
    AssignmentsModule,
    SubmissionsModule,

    MentorRequestsModule,
    StudyGroupsModule,
    EmailModule,
    DiscussionsModule,

  ],
  controllers: [AppController],
  providers:   [AppService],
})
export class AppModule {}
