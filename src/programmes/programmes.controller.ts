import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { UserProvisioningService } from '../users/user-provisioning.service.js';
import { AddProgrammeMemberDto, InviteCoachDto, ListProgrammeMembersDto, SearchProgrammeStudentsDto, SetProgrammeHeadsDto } from './dto/programme.dto.js';
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
  constructor(
    private readonly service:      ProgrammesService,
    private readonly provisioning: UserProvisioningService,
  ) {}

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

  /**
   * Students who can be added to the programme, by name or username: active STUDENT accounts
   * that are not active members of it. For a Head Coach (programmes they head only; other
   * programmes → 404) only students who are not active members of ANY programme — moving a
   * student from another programme stays an Administrator action. Name, username, grade,
   * division and school only (no contact details, grades or feedback, D7).
   */
  @Get(':id/student-candidates')
  @RequirePermission('programmes.manageMembers')
  studentCandidates(@Param('id', ParseUUIDPipe) id: string, @Query() query: SearchProgrammeStudentsDto, @CurrentUser() user: AuthUser) {
    return this.service.studentCandidates(id, query, user);
  }

  /**
   * Add (or re-activate) a membership. Head Coaches: students only, and only a student who is not an
   * active member of another programme (409 STUDENT_IN_OTHER_PROGRAMME — an Administrator moves them).
   */
  @Post(':id/members')
  @RequirePermission('programmes.manageMembers')
  addMember(@Param('id', ParseUUIDPipe) id: string, @Body() body: AddProgrammeMemberDto, @CurrentUser() user: AuthUser) {
    return this.service.addMember(id, body, user);
  }

  /**
   * Invite a Coach into the programme (users.manageCoaches). By a Head Coach (own
   * programmes only): the account is pending until an Administrator approves it
   * (PATCH /admin/users/:id/status); by an Administrator: approved at once.
   */
  @Post(':id/coach-invitations')
  @RequirePermission('users.manageCoaches')
  inviteCoach(@Param('id', ParseUUIDPipe) id: string, @Body() body: InviteCoachDto, @CurrentUser() user: AuthUser) {
    return this.provisioning.inviteCoachToProgramme(id, body, user);
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
