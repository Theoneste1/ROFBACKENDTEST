import { Module } from '@nestjs/common';
import { DashboardController, ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { DashboardService } from './dashboard.service.js';
import { UserReportsService } from './user-reports.service.js';
import { AcademicReportsService } from './academic-reports.service.js';
import { ReportScopeService } from './report-scope.js';

@Module({
  controllers: [DashboardController, ReportsController],
  // Prisma and Audit come from @Global() modules.
  providers:   [ReportsService, DashboardService, UserReportsService, AcademicReportsService, ReportScopeService],
})
export class ReportsModule {}
