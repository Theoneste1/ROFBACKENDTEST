import { Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';

import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../../common/auth-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { CreateSyncRunQueryDto, ListSyncRunsDto, SyncChangesQueryDto, SyncItemsQueryDto } from './school-sync.dto.js';
import { SchoolSyncService } from './school-sync.service.js';
import { SYNC_MAX_BYTES } from './sync-datasets.js';

/**
 * School directory sync — S2a: dry runs and their reports (schools.manage: Administrators and
 * Super Admins). Nothing here writes the directory: a run only stages its comparison. Contact
 * values are masked in every response and absent from report.csv. Review, approval and apply
 * (Super Admins only) are S2b.
 */
@ApiTags('Admin · School directory sync')
@ApiBearerAuth()
@Controller('admin/school-sync')
export class SchoolSyncController {
  constructor(private readonly service: SchoolSyncService) {}

  /**
   * Upload a source export (.xlsx or .csv, at most 10 MB / 10,000 rows) for a configured dataset:
   * always a dry run — the comparison is staged for review (24 hours); nothing else is written.
   */
  @Post('runs')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: SYNC_MAX_BYTES, files: 1 } }))
  @RequirePermission('schools.manage')
  create(@UploadedFile() file: Express.Multer.File | undefined, @Query() q: CreateSyncRunQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.dryRun(file, q, user);
  }

  /** Runs, newest first. */
  @Get('runs')
  @RequirePermission('schools.manage')
  list(@Query() q: ListSyncRunsDto) {
    return this.service.list(q);
  }

  /** A run: counts, the reconciliation with the source's totals, digests, status. */
  @Get('runs/:id')
  @RequirePermission('schools.manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  /** The run's rows (and directory schools missing from the source), contact values masked. */
  @Get('runs/:id/items')
  @RequirePermission('schools.manage')
  items(@Param('id', ParseUUIDPipe) id: string, @Query() q: SyncItemsQueryDto) {
    return this.service.items(id, q);
  }

  /** The proposed changes, one per field or addition, contact values masked. */
  @Get('runs/:id/changes')
  @RequirePermission('schools.manage')
  changes(@Param('id', ParseUUIDPipe) id: string, @Query() q: SyncChangesQueryDto) {
    return this.service.changes(id, q);
  }

  /** The run as CSV — no contact column. */
  @Get('runs/:id/report.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('schools.manage')
  async report(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { fileName, csv } = await this.service.reportCsv(id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(csv);
  }
}
