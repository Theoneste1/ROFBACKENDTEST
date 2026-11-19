import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ipTracker, userOrIpTracker } from '../common/rate-limit.js';
import { join } from 'path';

import { validateEnv } from '../config/env.validation.js';
import { RequestIdMiddleware } from '../common/middleware/request-id.middleware.js';
import { AccessModule } from '../common/access/access.module.js';
import { StorageModule } from '../common/storage/storage.module.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { DateOfBirthGuard } from '../auth/guards/date-of-birth.guard.js';

import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthController } from './health.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { FormsModule } from '../forms/forms.module.js';
import { ReferenceDataModule } from '../reference-data/reference-data.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DivisionsModule } from '../divisions/divisions.module.js';
import { AcademicYearsModule } from '../academic-years/academic-years.module.js';
import { ActivityModule } from '../activity/activity.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { PermissionsModule } from '../auth/permissions.module.js';
import { SuperAdminModule } from '../super-admin/super-admin.module.js';
import { PermissionOverridesModule } from '../permission-overrides/permission-overrides.module.js';
import { ProgrammesModule } from '../programmes/programmes.module.js';
import { TeachersModule } from '../teachers/teachers.module.js';
import { SchoolAffiliationModule } from '../schools/affiliations/school-affiliation.module.js';
import { PermissionGuard } from '../auth/guards/permission.guard.js';
import { AdminRequestAuditMiddleware } from '../audit/admin-request-audit.middleware.js';
import { UsersModule } from '../users/users.module.js';
import { BulkModule } from '../bulk/bulk.module.js';
import { SchoolsModule } from '../schools/schools.module.js';
import { CoursesModule } from '../courses/courses.module.js';
import { MentorAssignmentsModule } from '../mentor-assignments/mentor-assignments.module.js';
import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { AssignmentsModule } from '../assignments/assignments.module.js';
import { SubmissionsModule } from '../submissions/submissions.module.js';
import { MentorRequestsModule } from '../mentor-requests/mentor-requests.module.js';
import { TeacherApplicationsModule } from '../teacher-applications/teacher-applications.module.js';
import { ApplicationInfoRequestsModule } from '../application-info-requests/application-info-requests.module.js';
import { RegistrationAvatarModule } from '../users/registration-avatar.controller.js';
import { DecisionNotificationsModule } from '../decision-notifications/decision-notifications.module.js';
import { PublicSiteModule } from '../public-site/public-site.module.js';
import { EmailModule } from '../email/email.module.js';
import { DiscussionsModule } from '../discussions/discussions.module.js';
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
        // Rate limits (src/common/rate-limit.ts): `default` counts a signed-in request against the user (valid access
        // token) and anything else against the IP; `ip` is a per-address ceiling over everything (school labs share
        // one address, so it is much higher than any one user's budget).
        throttlers: [
          {
            name:  'default',
            ttl:   Number(config.get('THROTTLE_TTL_SECONDS') ?? 60) * 1000,
            limit: Number(config.get('THROTTLE_LIMIT') ?? 120),
            getTracker: userOrIpTracker(config.getOrThrow<string>('JWT_SECRET')),
          },
          {
            name:  'ip',
            ttl:   60_000,
            limit: Number(config.get('THROTTLE_IP_LIMIT') ?? 3000),
            getTracker: ipTracker,
          },
        ],
        // Only for automated tests: ignored unless NODE_ENV=test. Read per request, so one test file can turn the
        // limits on (test/rate-limit.e2e-spec.ts).
        skipIf: () => config.get('NODE_ENV') === 'test' && process.env.THROTTLE_DISABLED === 'true',
      }),
    }),
    EventEmitterModule.forRoot({ wildcard: false, ignoreErrors: true }),
    ScheduleModule.forRoot(),

    // ── Infrastructure (global) ───────────────────────────────────────────
    PrismaModule,
    AuditModule,
    SettingsModule,
    FormsModule,
    ReferenceDataModule,
    StorageModule,
    AccessModule,
    NotificationsModule,
    DivisionsModule,
    AcademicYearsModule,
    ActivityModule,

    // ── Features ──────────────────────────────────────────────────────────
    AuthModule,
    PermissionsModule,
    SuperAdminModule,
    PermissionOverridesModule,
    ProgrammesModule,
    TeachersModule,
    SchoolAffiliationModule,
    UsersModule,
    BulkModule,
    SchoolsModule,
    CoursesModule,
    MentorAssignmentsModule,
    AssignmentsModule,
    SubmissionsModule,
    LeaderboardModule,
    MentorRequestsModule,
    TeacherApplicationsModule,
    ApplicationInfoRequestsModule,
    RegistrationAvatarModule,
    DecisionNotificationsModule,
    PublicSiteModule,
    // StudyGroupsModule is intentionally not registered: the programme has no
    // separate study groups (all discussion is in course and assignment threads).
    // Its code and tables are kept; re-add it here to switch it back on.
    EmailModule,
    DiscussionsModule,
    AnalyticsModule,
    ReportsModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    // Order matters: rate limit → authenticate → authorize.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // A student without a date of birth gives it first (owner decision 9.3).
    { provide: APP_GUARD, useClass: DateOfBirthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // No-op on routes without @RequirePermission (P1-04: none yet).
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Request id first; then one audit row per state-changing ADMIN / SUPER_ADMIN request,
    // written when the response finishes (so guard refusals are included). P1-08.
    consumer.apply(RequestIdMiddleware, AdminRequestAuditMiddleware).forRoutes('*path');
  }
}
