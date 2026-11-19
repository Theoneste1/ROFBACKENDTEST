/**
 * Generic bulk routes (2026-11-19; capability bulkOperationsGeneric; docs/operations/bulk-operations.md). Every route
 * needs users.bulkManage — the gate, held only by Administrators and Super Administrators; it is never sufficient:
 * each action also needs its own permission(s) (checked in BulkOperationsService at preview and execute, and per
 * record by the worker), and each record the same policies as a single change.
 * /admin/users/bulk/* remain, unchanged, as the USER record type's own routes.
 */
import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { BulkOperationsService } from './bulk-operations.service.js';
import { BulkRegistry } from './bulk-registry.js';
import {
  EntityTypeParam, GenericBulkExecuteDto, GenericBulkExportDto, GenericBulkPreviewDto, GenericListBulkItemsDto, GenericListBulkOperationsDto,
} from './bulk.dto.js';

const typePipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

@ApiTags('Admin · Bulk operations')
@ApiBearerAuth()
@Controller('admin/bulk')
export class BulkController {
  constructor(private readonly bulk: BulkOperationsService, private readonly registry: BulkRegistry) {}

  /** The record types and actions YOU may run (from your effective permissions), with reason and consequence. */
  @Get('actions')
  @RequirePermission('users.bulkManage')
  actions(@CurrentUser() user: AuthUser) {
    return this.bulk.actionsFor(user);
  }

  /** Your operations of every record type (all operations with audit.view), newest first (?status=, ?entityType=). */
  @Get('operations')
  @RequirePermission('users.bulkManage')
  list(@Query() query: GenericListBulkOperationsDto, @CurrentUser() user: AuthUser) {
    return this.bulk.list(query, user);
  }

  /** Progress: status, total, succeeded, failed, skipped, pending, processing. */
  @Get('operations/:id')
  @RequirePermission('users.bulkManage')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.bulk.get(id, user);
  }

  /** Per-record results (?outcome=SUCCEEDED|FAILED|SKIPPED|PENDING|PROCESSING): entityId, outcome, code, message. */
  @Get('operations/:id/items')
  @RequirePermission('users.bulkManage')
  items(@Param('id', ParseUUIDPipe) id: string, @Query() query: GenericListBulkItemsDto, @CurrentUser() user: AuthUser) {
    return this.bulk.items(id, query, user);
  }

  /** Stops the operation: records not yet processed are skipped (CANCELLED); processed ones keep their result. */
  @Post('operations/:id/cancel')
  @HttpCode(200)
  @RequirePermission('users.bulkManage')
  cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.bulk.cancel(id, user);
  }

  /** What the action would do now (count, sample, warnings, consequences) and the 15-minute confirmation. Changes nothing. */
  @Post(':entityType/preview')
  @HttpCode(200)
  @RequirePermission('users.bulkManage')
  async preview(@Param() { entityType }: EntityTypeParam, @Body() body: GenericBulkPreviewDto, @CurrentUser() user: AuthUser) {
    return this.bulk.preview(entityType, await this.typed(entityType, body), user);
  }

  /** CSV of the selected records (record types with an export; safe fields only). Audited. */
  @Post(':entityType/export')
  @RequirePermission('users.bulkManage')
  async export(@Param() { entityType }: EntityTypeParam, @Body() body: GenericBulkExportDto, @CurrentUser() user: AuthUser,
    @Req() req: Request & { id?: string }, @Res() res: Response) {
    const { selection } = await this.typed(entityType, body);
    await this.bulk.export(entityType, { selection }, user, res, req.id ?? null);
  }

  /**
   * Starts the action on exactly the previewed records: 202 with the operation (200 with the same operation when the
   * idempotencyKey was already used). 409 SELECTION_CHANGED, 410 CONFIRMATION_EXPIRED, 403 CONFIRMATION_WRONG_ADMINISTRATOR,
   * 400 CONFIRMATION_INVALID, 409 CONFIRMATION_USED (a confirmation creates one operation).
   */
  @Post(':entityType')
  @HttpCode(202)
  @RequirePermission('users.bulkManage')
  async execute(@Param() { entityType }: EntityTypeParam, @Body() body: GenericBulkExecuteDto, @CurrentUser() user: AuthUser,
    @Req() req: Request & { id?: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.bulk.execute(entityType, await this.typed(entityType, body), user, req.id ?? null);
    res.status(result.alreadyExisted ? 200 : 202);
    return result;
  }

  /** `selection` and `params` validated with the record type's own DTOs (for USER: those of /admin/users/bulk). */
  private async typed<T extends { selection: object; params?: object }>(entityType: string, body: T): Promise<T> {
    const h = this.registry.get(entityType);
    const selection = await typePipe.transform(body.selection, { type: 'body', metatype: h.selectionDto });
    const params = body.params === undefined ? undefined : await typePipe.transform(body.params, { type: 'body', metatype: h.paramsDto });
    return { ...body, selection, ...(params !== undefined && { params }) };
  }
}
