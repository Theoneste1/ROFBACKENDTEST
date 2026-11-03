import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { join } from 'path';

import { validateEnv } from '../config/env.validation.js';
import { RequestIdMiddleware } from '../common/middleware/request-id.middleware.js';
import { AccessModule } from '../common/access/access.module.js';
import { StorageModule } from '../common/storage/storage.module.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthController } from './health.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DivisionsModule } from '../divisions/divisions.module.js';
import { AcademicYearsModule } from '../academic-years/academic-years.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { UsersModule } from '../users/users.module.js';
import { SchoolsModule } from '../schools/schools.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { MentorAssignmentsModule } from '../mentor-assignments/mentor-assignments.module.js';
import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { AssignmentsModule } from '../assignments/assignments.module.js';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { MentorRequestsModule } from '../mentor-requests/mentor-requests.module.js';
import { EmailModule } from '../email/email.module.js';
import { DiscussionsModule } from '../discussions/discussions.module.js';
import { LiveSessionsModule } from '../live-sessions/live-sessions.module.js';
import { AnalyticsModule } from '../analytics/analytics.module.js';
import { ReportsModule } from '../reports/reports.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal:    true,
      envFilePath: join(process.cwd(), '.env'),
      validate:    validateEnv,
    }),

    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{
          ttl:   Number(config.get('THROTTLE_TTL_SECONDS') ?? 60) * 1000,
          limit: Number(config.get('THROTTLE_LIMIT') ?? 120),
        }],
        // Only for automated tests; never set this in a deployed environment.
        skipIf: () => config.get('THROTTLE_DISABLED') === 'true',
      }),
    }),
    EventEmitterModule.forRoot({ wildcard: false, ignoreErrors: true }),
    ScheduleModule.forRoot(),

    // ── Infrastructure (global) ───────────────────────────────────────────
    PrismaModule,
    AuditModule,
    SettingsModule,
    StorageModule,
    AccessModule,
    NotificationsModule,
    DivisionsModule,
    AcademicYearsModule,
    ActivityModule,

    // ── Features ──────────────────────────────────────────────────────────
    AuthModule,
    UsersModule,
    SchoolsModule,
    CoursesModule,
    MentorAssignmentsModule,
    AssignmentsModule,
    SubmissionsModule,
    LeaderboardModule,
    MentorRequestsModule,
    // StudyGroupsModule is intentionally not registered: the programme has no
    // separate study groups (all discussion is in course and assignment threads).
    // Its code and tables are kept; re-add it here to switch it back on.
    EmailModule,
    DiscussionsModule,
    LiveSessionsModule,
    AnalyticsModule,
    ReportsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    // Order matters: rate limit → authenticate → authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*path');
  }
}
