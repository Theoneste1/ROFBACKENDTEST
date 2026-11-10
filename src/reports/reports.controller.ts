import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import type { Response } from 'express';

import { ReportsService } from './reports.service.js';
import { DashboardService } from './dashboard.service.js';
import { UserReportsService } from './user-reports.service.js';
import { AcademicReportsService } from './academic-reports.service.js';
import { AssignmentReportDto, ReportFiltersDto, ReportListDto, UserReportDto } from './dto/report-filters.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { AuditService } from '../audit/audit.service.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

class ResultsReportDto {
  @IsOptional() @IsUUID() assignmentId?: string;
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsUUID() divisionId?: string;
}

class DivisionReportDto {
  @IsUUID() divisionId: string;
}

/**
 * Dashboard: live statistics (reports.view). Filters: academicYearId (default
 * current; "all"), divisionId, courseId, from, to. A Head Coach gets the
 * programmes they head only, without the moderation and account sections.
 */
@ApiTags('Admin · Dashboard')
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermission('reports.view')
  get(@Query() q: ReportFiltersDto, @CurrentUser() user: AuthUser) {
    return this.dashboard.dashboard(q, user);
  }
}

/**
 * Administrator reports. Each report is available as JSON (lists paginated)
 * and as a CSV download (`….csv`, same filters, every row). Filters:
 * academicYearId (default current; "all"), divisionId, courseId, from, to,
 * and status (account status) on user reports.
 *
 * Head Coaches (P1-10, programme scope): students and course participation
 * (reports.view), coaches and coach activity (coaches.monitor) — never CSV
 * exports (reports.export, H8) or the other administrator reports.
 */
@ApiTags('Admin · Reports')
@Controller('admin/reports')
export class ReportsController {
  constructor(
    private readonly reports:  ReportsService,
    private readonly users:    UserReportsService,
    private readonly academic: AcademicReportsService,
    private readonly audit:    AuditService,
  ) {}

  /** What is waiting for an administrator right now. */
  @Get('overview')
  @Roles('ADMIN', 'SUPER_ADMIN')
  overview() {
    return this.reports.overview();
  }

  // ─── User reports ─────────────────────────────────────────────────────────

  @Get('students')
  @RequirePermission('reports.view')
  students(@Query() q: UserReportDto, @CurrentUser() user: AuthUser) {
    return this.users.students(q, user);
  }

  @Get('students.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async studentsCsv(@Query() q: UserReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'students', await this.users.studentsCsv(q, user), user, q);
  }

  @Get('mentors')
  @RequirePermission('coaches.monitor')
  mentors(@Query() q: UserReportDto, @CurrentUser() user: AuthUser) {
    return this.users.mentors(q, user);
  }

  @Get('mentors.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async mentorsCsv(@Query() q: UserReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'mentors', await this.users.mentorsCsv(q, user), user, q);
  }

  @Get('enrollment')
  @Roles('ADMIN', 'SUPER_ADMIN')
  enrollment(@Query() q: ReportListDto, @CurrentUser() user: AuthUser) {
    return this.users.enrollment(q, user);
  }

  @Get('enrollment.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async enrollmentCsv(@Query() q: ReportListDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'enrollment', await this.users.enrollmentCsv(q, user), user, q);
  }

  @Get('course-participation')
  @RequirePermission('reports.view')
  courseParticipation(@Query() q: ReportListDto, @CurrentUser() user: AuthUser) {
    return this.users.courseParticipation(q, user);
  }

  @Get('course-participation.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async courseParticipationCsv(@Query() q: ReportListDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'course-participation', await this.users.courseParticipationCsv(q, user), user, q);
  }

  // ─── Academic reports ─────────────────────────────────────────────────────

  @Get('assignments')
  @Roles('ADMIN', 'SUPER_ADMIN')
  assignments(@Query() q: AssignmentReportDto, @CurrentUser() user: AuthUser) {
    return this.academic.assignments(q, user);
  }

  @Get('assignments.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async assignmentsCsv(@Query() q: AssignmentReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'assignments', await this.academic.assignmentsCsv(q, user), user, q);
  }

  @Get('reviews')
  @Roles('ADMIN', 'SUPER_ADMIN')
  reviews(@Query() q: ReportFiltersDto, @CurrentUser() user: AuthUser) {
    return this.academic.reviews(q, user);
  }

  @Get('reviews.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async reviewsCsv(@Query() q: ReportFiltersDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'reviews', await this.academic.reviewsCsv(q, user), user, q);
  }

  @Get('results-publication')
  @Roles('ADMIN', 'SUPER_ADMIN')
  resultsPublication(@Query() q: ReportListDto, @CurrentUser() user: AuthUser) {
    return this.academic.resultsPublication(q, user);
  }

  @Get('results-publication.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async resultsPublicationCsv(@Query() q: ReportListDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'results-publication', await this.academic.resultsPublicationCsv(q, user), user, q);
  }

  @Get('mentor-activity')
  @RequirePermission('coaches.monitor')
  mentorActivity(@Query() q: UserReportDto, @CurrentUser() user: AuthUser) {
    return this.academic.mentorActivity(q, user);
  }

  @Get('mentor-activity.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async mentorActivityCsv(@Query() q: UserReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'mentor-activity', await this.academic.mentorActivityCsv(q, user), user, q);
  }

  // ─── Earlier exports (unchanged) ──────────────────────────────────────────

  /** One row per submission with its result (by assignment, or course × division). */
  @Get('results.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async results(@Query() q: ResultsReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'results', await this.reports.resultsCsv(q), user, q);
  }

  @Get('student-progress.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async studentProgress(@Query() q: DivisionReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'student-progress', await this.reports.studentProgressCsv(q.divisionId), user, q);
  }

  @Get('mentor-workload.csv')
  @RequirePermission('reports.export')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async mentorWorkload(@CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.sendCsv(res, 'mentor-workload', await this.reports.mentorWorkloadCsv(), user, {});
  }

  /**
   * Exports contain personal data, so every download is audited (with its
   * filters) — and the entry is saved before the file is sent.
   */
  private async sendCsv(res: Response, name: string, csv: string, user: AuthUser, filters: object) {
    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'EXPORT_REPORT', entity: 'Report',
      metadata: { report: name, filters: { ...filters } },
    });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${date}.csv"`);
    res.send(csv);
  }
}
