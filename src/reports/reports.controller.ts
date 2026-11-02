import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import type { Response } from 'express';

import { ReportsService } from './reports.service.js';
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

@ApiTags('Admin · Reports')
@Controller('admin/reports')
@Roles('ADMIN')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly audit:   AuditService,
  ) {}

  /** Dashboard: active users, students per division and everything awaiting action. */
  @Get('overview')
  overview() {
    return this.reports.overview();
  }

  @Get('results.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async results(@Query() q: ResultsReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'results', await this.reports.resultsCsv(q), user);
  }

  @Get('student-progress.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async studentProgress(@Query() q: DivisionReportDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'student-progress', await this.reports.studentProgressCsv(q.divisionId), user);
  }

  @Get('mentor-workload.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async mentorWorkload(@CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'mentor-workload', await this.reports.mentorWorkloadCsv(), user);
  }

  @Get('enrollment.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  async enrollment(@CurrentUser() user: AuthUser, @Res() res: Response) {
    this.sendCsv(res, 'enrollment', await this.reports.enrollmentCsv(), user);
  }

  /** Exports contain personal data, so every download is audited. */
  private sendCsv(res: Response, name: string, csv: string, user: AuthUser) {
    void this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'EXPORT_REPORT', entity: 'Report', metadata: { report: name },
    });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}-${date}.csv"`);
    res.send(csv);
  }
}
