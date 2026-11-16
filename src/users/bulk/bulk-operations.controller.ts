/**
 * Bulk user operations (capability bulkUserOperations; docs/operations/bulk-user-operations.md). Every route needs
 * users.bulkManage (export: users.export); each action also needs its own permission (checked in the service), and
 * each account the same policies as a single change (checked per account by the worker).
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../../common/auth-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { BulkOperationsService } from './bulk-operations.service.js';
import { BulkExecuteDto, BulkExportDto, BulkPreviewDto, ListBulkItemsDto, ListBulkOperationsDto } from './bulk.dto.js';

@ApiTags('Admin · Users')
@Controller('admin/users/bulk')
export class BulkOperationsController {
  constructor(private readonly bulk: BulkOperationsService) {}

  /**
   * What the action would do, now: the number of matching accounts, a sample (≤ 10), warnings, consequences, whether a
   * reason or step-up is needed, and the selectionToken to confirm with. Changes nothing.
   */
  @Post('preview')
  @HttpCode(200)
  @RequirePermission('users.bulkManage')
  preview(@Body() body: BulkPreviewDto, @CurrentUser() user: AuthUser) {
    return this.bulk.preview(body, user);
  }

  /**
   * Starts the action on exactly the previewed accounts: 202 with the operation (200 with the same operation when the
   * idempotencyKey was already used). 409 SELECTION_CHANGED when the accounts no longer match the preview.
   */
  @Post()
  @RequirePermission('users.bulkManage')
  async execute(@Body() body: BulkExecuteDto, @CurrentUser() user: AuthUser, @Req() req: Request & { id?: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.bulk.execute(body, user, req.id ?? null);
    res.status(result.alreadyExisted ? 200 : 202);
    return result;
  }

  /** The caller's operations (all operations for administrators who hold audit.view), newest first. */
  @Get()
  @RequirePermission('users.bulkManage')
  list(@Query() query: ListBulkOperationsDto, @CurrentUser() user: AuthUser) {
    return this.bulk.list(query, user);
  }

  /** CSV of the selected accounts (name, username, e-mail, role, state, school, grade, created). Audited. */
  @Post('export')
  @RequirePermission('users.export')
  async export(@Body() body: BulkExportDto, @CurrentUser() user: AuthUser, @Req() req: Request & { id?: string }, @Res() res: Response) {
    await this.bulk.export(body, user, res, req.id ?? null);
  }

  /** Progress: status, total, succeeded, failed, skipped, pending. */
  @Get(':id')
  @RequirePermission('users.bulkManage')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.bulk.get(id, user);
  }

  /** Per-account results (?outcome=SUCCEEDED|FAILED|SKIPPED|PENDING), with the reason code of each failure or skip. */
  @Get(':id/items')
  @RequirePermission('users.bulkManage')
  items(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListBulkItemsDto, @CurrentUser() user: AuthUser) {
    return this.bulk.items(id, query, user);
  }

  /** Stops the operation: accounts not yet processed are skipped (CANCELLED); processed ones keep their result. */
  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission('users.bulkManage')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.bulk.cancel(id, user);
  }
}
