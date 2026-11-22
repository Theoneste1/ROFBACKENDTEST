import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import {
  ReportDefinitionDto, ReportExportQueryDto, ReportPageQueryDto, SaveReportDto, SetReportGrantsDto,
} from './custom-reports.dto.js';
import { CustomReportsService } from './custom-reports.service.js';

/**
 * Custom reports (owner 2026-11-22). Building them: reports.build (Administrators). Using a shared report: any
 * signed-in user — the report's grants decide (view, download, edit), checked by the service on every call; anyone
 * without a level gets 404.
 */
@ApiTags('custom-reports')
@Controller('reports')
export class CustomReportsController {
  constructor(private readonly reports: CustomReportsService) {}

  /** The sources and their fields, and the filter conditions (for the builder). */
  @Get('sources')
  @RequirePermission('reports.build')
  sources() {
    return this.reports.catalogue();
  }

  /** The reports the caller may open, with their levels on each. */
  @Get()
  @Authenticated()
  list(@CurrentUser() user: AuthUser) {
    return this.reports.list(user);
  }

  @Post()
  @RequirePermission('reports.build')
  create(@Body() body: SaveReportDto, @CurrentUser() user: AuthUser) {
    return this.reports.create(body, user);
  }

  /** An unsaved definition's first rows. */
  @Post('preview')
  @RequirePermission('reports.build')
  preview(@Body() body: ReportDefinitionDto, @Query() q: ReportPageQueryDto, @CurrentUser() user: AuthUser) {
    return this.reports.preview(body, user, q.page, q.limit);
  }

  @Get(':id')
  @Authenticated()
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.reports.get(id, user);
  }

  /** Change the definition (edit level). */
  @Put(':id')
  @Authenticated()
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: SaveReportDto, @CurrentUser() user: AuthUser) {
    return this.reports.update(id, body, user);
  }

  /** Remove it (its creator or a builder); kept for history. */
  @Delete(':id')
  @Authenticated()
  remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.reports.remove(id, user);
  }

  /** A changed definition's first rows (edit level). */
  @Post(':id/preview')
  @Authenticated()
  previewFor(@Param('id', ParseUUIDPipe) id: string, @Body() body: ReportDefinitionDto, @Query() q: ReportPageQueryDto, @CurrentUser() user: AuthUser) {
    return this.reports.previewFor(id, body, user, q.page, q.limit);
  }

  /** The report's rows, a page at a time (view level). */
  @Get(':id/run')
  @Authenticated()
  run(@Param('id', ParseUUIDPipe) id: string, @Query() q: ReportPageQueryDto, @CurrentUser() user: AuthUser) {
    return this.reports.run(id, user, q.page, q.limit);
  }

  /** CSV or Excel (download level). */
  @Get(':id/export')
  @Authenticated()
  async export(@Param('id', ParseUUIDPipe) id: string, @Query() q: ReportExportQueryDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.reports.export(id, q.format, user, res);
  }

  /** Who has access, with their levels (its creator or a builder). */
  @Get(':id/grants')
  @Authenticated()
  grants(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.reports.grants(id, user);
  }

  /** Replace who has access (its creator or a builder). Audited. */
  @Put(':id/grants')
  @Authenticated()
  setGrants(@Param('id', ParseUUIDPipe) id: string, @Body() body: SetReportGrantsDto, @CurrentUser() user: AuthUser) {
    return this.reports.setGrants(id, body.grants, user);
  }
}
