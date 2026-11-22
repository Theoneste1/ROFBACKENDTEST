import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsString, Length, ValidateNested } from 'class-validator';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { TableLayoutsService } from './table-layouts.service.js';

export class ColumnSettingDto {
  @IsString() @Length(1, 50) key: string;
  @IsBoolean() visible: boolean;
}

/** PUT …/table-layouts/:table — the columns in order, each shown or hidden. */
export class SaveTableLayoutDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ColumnSettingDto)
  columns: ColumnSettingDto[];
}

/**
 * Table layouts (owner 2026-11-22). The caller's own: users.view (whoever sees the user tables). The organization
 * default: settings.manage (Administrators).
 */
@ApiTags('table-layouts')
@Controller()
export class TableLayoutsController {
  constructor(private readonly layouts: TableLayoutsService) {}

  /** The effective layout (own, else organization, else built-in), its source, the organization default, every column. */
  @Get('me/table-layouts/:table')
  @RequirePermission('users.view')
  mine(@Param('table') table: string, @CurrentUser() user: AuthUser) {
    return this.layouts.effective(table, user.id);
  }

  @Put('me/table-layouts/:table')
  @RequirePermission('users.view')
  saveMine(@Param('table') table: string, @Body() body: SaveTableLayoutDto, @CurrentUser() user: AuthUser) {
    return this.layouts.saveMine(table, body.columns, user);
  }

  /** Back to the organization default. */
  @Delete('me/table-layouts/:table')
  @RequirePermission('users.view')
  resetMine(@Param('table') table: string, @CurrentUser() user: AuthUser) {
    return this.layouts.resetMine(table, user);
  }

  @Put('admin/table-layouts/:table')
  @RequirePermission('settings.manage')
  saveOrg(@Param('table') table: string, @Body() body: SaveTableLayoutDto, @CurrentUser() user: AuthUser) {
    return this.layouts.saveOrg(table, body.columns, user);
  }

  /** The organization default back to the built-in one. */
  @Delete('admin/table-layouts/:table')
  @RequirePermission('settings.manage')
  resetOrg(@Param('table') table: string, @CurrentUser() user: AuthUser) {
    return this.layouts.resetOrg(table, user);
  }
}
