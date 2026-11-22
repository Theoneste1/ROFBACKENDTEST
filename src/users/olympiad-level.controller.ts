import { Body, Controller, Get, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { SetOlympiadLevelDto } from './dto/olympiad-level.dto.js';
import { OlympiadLevelService } from './olympiad-level.service.js';

/**
 * A student's Olympiad level (owner 2026-11-21): students.classifyLevel — User Managers (every student); Coaches and
 * Head Coaches (the students of their programmes; any other student: 404).
 */
@ApiTags('olympiad-levels')
@Controller('admin/students')
export class OlympiadLevelController {
  constructor(private readonly levels: OlympiadLevelService) {}

  /** The level, whether it was set by hand, the grade's suggestion, and the history (newest first). */
  @Get(':id/olympiad-level')
  @RequirePermission('students.classifyLevel')
  view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.levels.view(id, user);
  }

  /** Set the level by hand ({ level, reason }) or follow the grade again ({ automatic: true, reason }). Audited. */
  @Put(':id/olympiad-level')
  @RequirePermission('students.classifyLevel')
  set(@Param('id', ParseUUIDPipe) id: string, @Body() body: SetOlympiadLevelDto, @CurrentUser() user: AuthUser) {
    return this.levels.set(id, body, user);
  }
}
