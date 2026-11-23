import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { CoachStudentsQueryDto, SetCoachAccessDto } from './coach-access.dto.js';
import { CoachAccessService } from './coach-access.service.js';

/** Coaches (owner 2026-11-23): the students of their programmes, every level (never contact details). */
@ApiTags('Coach')
@Controller('coach')
export class CoachStudentsController {
  constructor(private readonly service: CoachAccessService) {}

  @Get('students')
  @RequirePermission('students.viewProgramme')
  students(@Query() q: CoachStudentsQueryDto, @CurrentUser() user: AuthUser) {
    return this.service.students(user, q);
  }
}

/**
 * A coach's programme-wide access (owner 2026-11-23): Administrators (every programme) and Head Coaches (the programmes
 * they head) see it and take any part away — or give it back — per programme, with a reason. Audited.
 */
@ApiTags('Coaches')
@Controller('admin/coaches')
export class CoachAccessController {
  constructor(private readonly service: CoachAccessService) {}

  @Get(':id/programme-access')
  @RequirePermission('users.manageCoaches')
  get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.get(id, user);
  }

  /** 400 REASON_REQUIRED / NOT_A_PROGRAMME_MEMBER; 403 SCOPE_FORBIDDEN (a Head Coach, another programme); 404 not a coach. */
  @Put(':id/programme-access')
  @RequirePermission('users.manageCoaches')
  set(@Param('id', ParseUUIDPipe) id: string, @Body() body: SetCoachAccessDto, @CurrentUser() user: AuthUser) {
    return this.service.set(id, body, user);
  }
}
