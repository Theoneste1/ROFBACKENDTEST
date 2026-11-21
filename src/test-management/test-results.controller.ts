import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import {
  ListTestResultsQueryDto, MyResultsQueryDto, OverridePublicationDto, PublicationPreviewQueryDto, PublicationsQueryDto, PublishTestResultsDto,
  RankingsQueryDto, ResultsExportQueryDto, ResultsReportQueryDto, SchoolResultsQueryDto, TestReportsQueryDto,
} from './dto/results.dto.js';
import { TestMarkerService } from './test-marker.service.js';
import { TestResultViewsService } from './test-result-views.service.js';
import { TestResultsService } from './test-results.service.js';

/**
 * Test Management, Phase 4 — publication, results, rankings and reports (capability testResults). Administrators: every
 * subject; Head Coaches: the subjects they head (403 SCOPE_FORBIDDEN otherwise). Publishing: tests.publishResults; the
 * override of unapproved results: tests.overridePublication — Administrators only (a Head Coach can never override).
 * Results with identity and reports: tests.viewResults; internal rankings: tests.viewRankings. Every write is audited
 * (TESTS) in the same transaction as the notices it sends.
 */
@ApiTags('Admin · Test results')
@Controller('admin/tests/:id/results')
export class AdminTestResultsController {
  constructor(private readonly results: TestResultsService) {}

  /** Final, approved results (published or not) with identity. Filters: published, schoolId, division, q. Paginated. */
  @Get()
  @RequirePermission('tests.viewResults')
  list(@Param('id', ParseUUIDPipe) id: string, @Query() q: ListTestResultsQueryDto, @CurrentUser() user: AuthUser) {
    return this.results.list(id, q, user);
  }

  /**
   * Before publishing: counts (by status; approved waiting; published; unapproved), the unapproved results (paginated),
   * extensions still running (warning), warnings, and what the caller may do (publish / blocked / override).
   */
  @Get('preview')
  @RequirePermission('tests.publishResults')
  preview(@Param('id', ParseUUIDPipe) id: string, @Query() q: PublicationPreviewQueryDto, @CurrentUser() user: AuthUser) {
    return this.results.preview(id, q, user);
  }

  /**
   * Publish the approved results: { clientKey? }. Blocked while any result is not approved (409 PUBLICATION_BLOCKED).
   * Nothing new to publish: the latest publication again (replayed: true; nothing sent twice). 409 NOTHING_TO_PUBLISH.
   */
  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.publishResults')
  publish(@Param('id', ParseUUIDPipe) id: string, @Body() dto: PublishTestResultsDto, @CurrentUser() user: AuthUser) {
    return this.results.publish(id, dto, user);
  }

  /**
   * Administrators: publish the approved results although some are not approved — { reason (10–1,000), clientKey? }.
   * Unapproved results stay hidden. Audited (TEST_PUBLICATION_OVERRIDDEN). Head Coaches: 403 (never).
   */
  @Post('publish/override')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('tests.overridePublication')
  publishWithOverride(@Param('id', ParseUUIDPipe) id: string, @Body() dto: OverridePublicationDto, @CurrentUser() user: AuthUser) {
    return this.results.publishWithOverride(id, dto, user);
  }

  /** Every publication (who, when, override and reason, counts) and the latest withdrawals (G6). */
  @Get('publications')
  @RequirePermission('tests.publishResults')
  publications(@Param('id', ParseUUIDPipe) id: string, @Query() q: PublicationsQueryDto, @CurrentUser() user: AuthUser) {
    return this.results.publications(id, q, user);
  }

  /** Internal ranking: by=overall|division|school (competition rank, deterministic ties); division, schoolId, published. */
  @Get('rankings')
  @RequirePermission('tests.viewRankings')
  rankings(@Param('id', ParseUUIDPipe) id: string, @Query() q: RankingsQueryDto, @CurrentUser() user: AuthUser) {
    return this.results.rankings(id, q, user);
  }

  /** Summary: counts, average / median / min / max, distribution, per question, per school, per division. */
  @Get('report')
  @RequirePermission('tests.viewResults')
  report(@Param('id', ParseUUIDPipe) id: string, @Query() q: ResultsReportQueryDto, @CurrentUser() user: AuthUser) {
    return this.results.report(id, q, user);
  }

  /** CSV download: type=results (default) | schools | divisions | questions; published. Audited. */
  @Get('export.csv')
  @ApiProduces('text/csv')
  @RequirePermission('tests.viewResults')
  async exportCsv(@Param('id', ParseUUIDPipe) id: string, @Query() q: ResultsExportQueryDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.results.exportCsv(id, q, user, res);
  }
}

/** Reporting across tests and the staff dashboard (Administrators: every subject; Head Coaches: the subjects they head). */
@ApiTags('Admin · Test results')
@Controller('admin')
export class AdminTestReportsController {
  constructor(private readonly results: TestResultsService, private readonly views: TestResultViewsService) {}

  /** Published tests with their counts, averages and publications. Filters: subjectId, q. Paginated. */
  @Get('test-reports')
  @RequirePermission('tests.viewResults')
  reports(@Query() q: TestReportsQueryDto, @CurrentUser() user: AuthUser) {
    return this.results.overview(q, user);
  }

  /** Dashboard (spec 12.1 / 12.3): per subject, the latest tests' progress, progress per coach, the latest ranking. */
  @Get('test-dashboard')
  @RequirePermission('tests.view')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.views.staffDashboard(user);
  }
}

/** Students: their own published results (marks per question, total, comments; never a rank). */
@ApiTags('My tests')
@Controller('me')
export class MyTestResultsController {
  constructor(private readonly views: TestResultViewsService) {}

  @Get('test-results')
  @RequirePermission('tests.viewOwnResults')
  list(@Query() q: MyResultsQueryDto, @CurrentUser() user: AuthUser) {
    return this.views.myResults(user, q);
  }

  /** 404 RESULT_NOT_FOUND unless published (an unapproved or withdrawn result is never revealed). */
  @Get('test-results/:testId')
  @RequirePermission('tests.viewOwnResults')
  get(@Param('testId', ParseUUIDPipe) testId: string, @CurrentUser() user: AuthUser) {
    return this.views.myResult(user, testId);
  }

  /** Student dashboard (spec 12.5): open / upcoming tests with my deadline, my submissions, my published results. */
  @Get('test-dashboard')
  @RequirePermission('tests.submit')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.views.studentDashboard(user);
  }
}

/** Teachers: published results of the verified students of their own schools (never a rank). */
@ApiTags('Teacher tests')
@Controller('teacher')
export class TeacherTestResultsController {
  constructor(private readonly views: TestResultViewsService) {}

  @Get('test-results')
  @RequirePermission('tests.viewSchoolResults')
  list(@Query() q: MyResultsQueryDto, @CurrentUser() user: AuthUser) {
    return this.views.schoolTests(user, q);
  }

  @Get('test-results/:testId')
  @RequirePermission('tests.viewSchoolResults')
  results(@Param('testId', ParseUUIDPipe) testId: string, @Query() q: SchoolResultsQueryDto, @CurrentUser() user: AuthUser) {
    return this.views.schoolResults(user, testId, q);
  }

  /** 404 RESULT_NOT_FOUND for another school's student, or a result not published. */
  @Get('test-results/:testId/students/:studentId')
  @RequirePermission('tests.viewSchoolResults')
  result(@Param('testId', ParseUUIDPipe) testId: string, @Param('studentId', ParseUUIDPipe) studentId: string, @CurrentUser() user: AuthUser) {
    return this.views.schoolResult(user, testId, studentId);
  }

  /** Teacher dashboard (spec 12.4): open tests with my students submitted / missing, extensions, published results. */
  @Get('test-dashboard')
  @RequirePermission('tests.submitForStudents')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.views.teacherDashboard(user);
  }
}

/** Coaches: the marking dashboard (spec 12.2) — their own assigned work only, blind. */
@ApiTags('Marking')
@Controller('marking')
export class MarkingDashboardController {
  constructor(private readonly marker: TestMarkerService) {}

  @Get('dashboard')
  @RequirePermission('tests.mark')
  dashboard(@CurrentUser() user: AuthUser) {
    return this.marker.dashboard(user);
  }
}
