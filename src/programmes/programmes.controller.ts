import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { AddProgrammeMemberDto, ListProgrammeMembersDto, SetProgrammeHeadsDto } from './dto/programme.dto.js';
import { ProgrammesService } from './programmes.service.js';

/** Programme list (read-only): anyone who may view courses. */
@ApiTags('Programmes')
@ApiBearerAuth()
@Controller('programmes')
export class ProgrammesController {
  constructor(private readonly service: ProgrammesService) {}

  @Get()
  @RequirePermission('courses.view')
  list() {
    return this.service.list();
  }
}

/**
 * Programme heads (Administrators: programmes.manageHeads) and members
 * (programmes.manageMembers: Administrators; Head Coaches in programmes they head).
 */
@ApiTags('Admin · Programmes')
@ApiBearerAuth()
@Controller('admin/programmes')
export class AdminProgrammesController {
  constructor(private readonly service: ProgrammesService) {}

  /** Head Coaches heading the programme. */
  @Get(':id/heads')
  @RequirePermission('programmes.manageHeads')
  heads(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.heads(id);
  }

  /** Replace the heads with exactly this list of HEAD_COACH users. */
  @Put(':id/heads')
  @RequirePermission('programmes.manageHeads')
  setHeads(@Param('id', ParseUUIDPipe) id: string, @Body() body: SetProgrammeHeadsDto, @CurrentUser() user: AuthUser) {
    return this.service.setHeads(id, body, user);
  }

  /** Students and Coaches in the programme (no contact details, grades or feedback). */
  @Get(':id/members')
  @RequirePermission('programmes.manageMembers')
  members(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListProgrammeMembersDto, @CurrentUser() user: AuthUser) {
    return this.service.members(id, query, user);
  }

  /** Add (or re-activate) a membership. Head Coaches: students only. */
  @Post(':id/members')
  @RequirePermission('programmes.manageMembers')
  addMember(@Param('id', ParseUUIDPipe) id: string, @Body() body: AddProgrammeMemberDto, @CurrentUser() user: AuthUser) {
    return this.service.addMember(id, body, user);
  }

  /** End a membership (kept as history). Head Coaches: students only. */
  @Delete(':id/members/:userId')
  @RequirePermission('programmes.manageMembers')
  endMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.endMember(id, userId, user);
  }
}
