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
 * Administrator dashboard: live statistics. Filters: academicYearId (default
 * current; "all"), divisionId, courseId, from, to.
 */
@ApiTags('Admin · Dashboard')
@Controller('admin/dashboard')
@Roles('ADMIN')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  get(@Query() q: ReportFiltersDto) {
    return this.dashboard.dashboard(q);
  }
}

/**
 * Administrator reports. Each report is available as JSON (lists paginated)
 * and as a CSV download (`….csv`, same filters, every row). Filters:
 * academicYearId (default current; "all"), divisionId, courseId, from, to,
 * and status (account status) on user reports.
 */
@ApiTags('Admin · Reports')
@Controller('admin/reports')
@Roles('ADMIN')
export class ReportsController {
  constructor(
    private readonly reports:  ReportsService,
    private readonly users:    UserReportsService,
    private readonly academic: AcademicReportsService,
    private readonly audit:    AuditService,
  ) {}

  /** What is waiting for an administrator right now. */
  @Get('overview')
  overview() {
    return this.reports.overview();
  }

  // ─── User reports ─────────────────────────────────────────────────────────

  @Get('students')
  students(@Query() q: UserReportDto) {
    return this.users.students(q);
  }

  @Get('students.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async studentsCsv(@Query() q: UserReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'students', await this.users.studentsCsv(q), user, q);
  }

  @Get('mentors')
  mentors(@Query() q: UserReportDto) {
    return this.users.mentors(q);
  }

  @Get('mentors.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async mentorsCsv(@Query() q: UserReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'mentors', await this.users.mentorsCsv(q), user, q);
  }

  @Get('enrollment')
  enrollment(@Query() q: ReportListDto) {
    return this.users.enrollment(q);
  }

  @Get('enrollment.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async enrollmentCsv(@Query() q: ReportListDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'enrollment', await this.users.enrollmentCsv(q), user, q);
  }

  @Get('course-participation')
  courseParticipation(@Query() q: ReportListDto) {
    return this.users.courseParticipation(q);
  }

  @Get('course-participation.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async courseParticipationCsv(@Query() q: ReportListDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'course-participation', await this.users.courseParticipationCsv(q), user, q);
  }

  // ─── Academic reports ─────────────────────────────────────────────────────

  @Get('assignments')
  assignments(@Query() q: AssignmentReportDto) {
    return this.academic.assignments(q);
  }

  @Get('assignments.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async assignmentsCsv(@Query() q: AssignmentReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'assignments', await this.academic.assignmentsCsv(q), user, q);
  }

  @Get('reviews')
  reviews(@Query() q: ReportFiltersDto) {
    return this.academic.reviews(q);
  }

  @Get('reviews.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async reviewsCsv(@Query() q: ReportFiltersDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'reviews', await this.academic.reviewsCsv(q), user, q);
  }

  @Get('results-publication')
  resultsPublication(@Query() q: ReportListDto) {
    return this.academic.resultsPublication(q);
  }

  @Get('results-publication.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async resultsPublicationCsv(@Query() q: ReportListDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'results-publication', await this.academic.resultsPublicationCsv(q), user, q);
  }

  @Get('mentor-activity')
  mentorActivity(@Query() q: UserReportDto) {
    return this.academic.mentorActivity(q);
  }

  @Get('mentor-activity.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async mentorActivityCsv(@Query() q: UserReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'mentor-activity', await this.academic.mentorActivityCsv(q), user, q);
  }

  // ─── Earlier exports (unchanged) ──────────────────────────────────────────

  /** One row per submission with its result (by assignment, or course × division). */
  @Get('results.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async results(@Query() q: ResultsReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'results', await this.reports.resultsCsv(q), user, q);
  }

  @Get('student-progress.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async studentProgress(@Query() q: DivisionReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'student-progress', await this.reports.studentProgressCsv(q.divisionId), user, q);
  }

  @Get('mentor-workload.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async mentorWorkload(@CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'mentor-workload', await this.reports.mentorWorkloadCsv(), user, {});
  }

  /** Exports contain personal data, so every download is audited (with its filters). */
  private sendCsv(res: Response, name: string, csv: string, user: AuthUser, filters: object) {
    void this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'EXPORT_REPORT', entity: 'Report',
      metadata: { report: name, filters: { ...filters } },
    });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${date}.csv"`);
    res.send(csv);
  }
}
