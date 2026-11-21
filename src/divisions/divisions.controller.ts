import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DivisionsService } from './divisions.service.js';
import { CreateDivisionDto, UpdateDivisionDto } from './dto/update-division.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Divisions')
@Controller()
export class DivisionsController {
  constructor(private readonly divisions: DivisionsService) {}

  /** Every division (Olympiad level) and its suggested grades, in display order (public — needed by the sign-up form). */
  @Public()
  @Get('divisions')
  findAll() {
    return this.divisions.findAll();
  }

  /** Admin view with student and mentor-assignment counts. */
  @Get('admin/divisions')
  @RequirePermission('divisions.manage')
  findAllAdmin() {
    return this.divisions.findAll(true);
  }

  /** A new division (owner 2026-11-21/22): its code is permanent; every grade must stay with one active division. */
  @Post('admin/divisions')
  @RequirePermission('divisions.manage')
  create(@Body() body: CreateDivisionDto, @CurrentUser() user: AuthUser) {
    return this.divisions.create(body, user);
  }

  @Patch('admin/divisions/:id')
  @RequirePermission('divisions.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDivisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.divisions.update(id, body, user);
  }
}
