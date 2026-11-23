import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import {
  RegistrationCategoryQueryDto, RegistrationExportQueryDto, RegistrationFieldsQueryDto, RegistrationPageQueryDto, RegistrationQueryDto,
  SaveRegistrationFilterDto, SaveRegistrationLayoutDto, UpdateRegistrationRecordDto,
} from './registration-data.dto.js';
import type { CategoryKey } from './field-policy.js';
import { RegistrationDataService } from './registration-data.service.js';
import { SavedViewsService } from './saved-views.service.js';

/**
 * Registration data (owner 2026-11-23): every eligible registration field of every account — listed, filtered, sorted,
 * exported and edited by Super Administrators (registrationData.manage). The fields come from the database through an
 * eligibility layer (src/registration-data/field-policy.ts): security data never appears.
 */
@ApiTags('registration-data')
@Controller('admin/registration-data')
export class RegistrationDataController {
  constructor(private readonly data: RegistrationDataService, private readonly views: SavedViewsService) {}

  /** A category's fields (type, choices, how each is edited), the filter conditions, and the default columns. */
  @Get('fields')
  @RequirePermission('registrationData.manage')
  fields(@Query() q: RegistrationFieldsQueryDto) {
    return this.data.fields(q.category);
  }

  /** One page of accounts: the chosen columns, filtered, searched and sorted by the database. */
  @Post('query')
  @HttpCode(200)
  @RequirePermission('registrationData.manage')
  query(@Body() body: RegistrationQueryDto, @Query() q: RegistrationPageQueryDto) {
    return this.data.query({ ...body, category: body.category as CategoryKey }, q.page, q.limit);
  }

  /** The filtered accounts as CSV or Excel: the chosen columns in order, every matching row (at most 200,000). Audited. */
  @Post('export')
  @HttpCode(200)
  @RequirePermission('registrationData.manage')
  async export(@Body() body: RegistrationQueryDto, @Query() q: RegistrationExportQueryDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    await this.data.export({ ...body, category: body.category as CategoryKey }, q.format, user, res);
  }

  /** One account's record: every field of its category, its value, and whether and how it can be changed. */
  @Get('users/:id')
  @RequirePermission('registrationData.manage')
  record(@Param('id', ParseUUIDPipe) id: string) {
    return this.data.record(id);
  }

  /** Change fields of one account's record (all checked first; one transaction; audited with old and new values). */
  @Patch('users/:id')
  @RequirePermission('registrationData.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateRegistrationRecordDto, @CurrentUser() user: AuthUser) {
    return this.data.update(id, body, user);
  }

  /** Your saved filters and those shared with you. */
  @Get('saved-filters')
  @RequirePermission('registrationData.manage')
  listFilters(@Query() q: RegistrationCategoryQueryDto, @CurrentUser() user: AuthUser) {
    return this.views.list(user, q.category);
  }

  @Post('saved-filters')
  @RequirePermission('registrationData.manage')
  createFilter(@Body() body: SaveRegistrationFilterDto, @CurrentUser() user: AuthUser) {
    return this.views.create(body, user);
  }

  /** Change your saved filter (only its owner). */
  @Put('saved-filters/:id')
  @RequirePermission('registrationData.manage')
  updateFilter(@Param('id', ParseUUIDPipe) id: string, @Body() body: SaveRegistrationFilterDto, @CurrentUser() user: AuthUser) {
    return this.views.update(id, body, user);
  }

  @Delete('saved-filters/:id')
  @RequirePermission('registrationData.manage')
  removeFilter(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.views.remove(id, user);
  }

  /** Your columns for a category (or the default ones). */
  @Get('layouts/:category')
  @RequirePermission('registrationData.manage')
  layout(@Param('category') category: string, @CurrentUser() user: AuthUser) {
    return this.views.layout(category, user);
  }

  @Put('layouts/:category')
  @RequirePermission('registrationData.manage')
  saveLayout(@Param('category') category: string, @Body() body: SaveRegistrationLayoutDto, @CurrentUser() user: AuthUser) {
    return this.views.saveLayout(category, body.columns, user);
  }

  /** Back to the default columns. */
  @Delete('layouts/:category')
  @RequirePermission('registrationData.manage')
  resetLayout(@Param('category') category: string, @CurrentUser() user: AuthUser) {
    return this.views.resetLayout(category, user);
  }
}
