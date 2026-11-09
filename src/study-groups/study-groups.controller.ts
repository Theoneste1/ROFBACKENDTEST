import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';

import { ApiTags } from '@nestjs/swagger';

import { StudyGroupsService } from './study-groups.service.js';
import { CreateStudyGroupDto } from './dto/create-study-group.dto.js';
import { UpdateStudyGroupDto } from './dto/update-study-group.dto.js';
import { AddMemberDto } from './dto/add-member.dto.js';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto.js';

import { Roles } from '../auth/decorators/roles.decorator.js';
import { GroupMemberGuard } from './guards/group-member.guard.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';

@ApiTags('Study groups')
@Controller('study-groups')
export class StudyGroupsController {
  constructor(private readonly studyGroupsService: StudyGroupsService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN — group management
  // ═══════════════════════════════════════════════════════════════════════════

  /** ADMIN: Create a new study group. */
  @Post()
  @Roles('ADMIN')
  create(@Body() body: CreateStudyGroupDto, @Request() req: any) {
    return this.studyGroupsService.create(body, { id: req.user.id, role: req.user.role });
  }

  /** ADMIN: Update group name, description, tags, or active status. */
  @Patch(':id')
  @Roles('ADMIN')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStudyGroupDto,
    @Request() req: any,
  ) {
    return this.studyGroupsService.update(id, body, { id: req.user.id, role: req.user.role });
  }

  /** ADMIN: List all groups (active and inactive). */
  @Get()
  @Roles('ADMIN')
  findAll() {
    return this.studyGroupsService.findAll();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN — membership management
  // ═══════════════════════════════════════════════════════════════════════════

  /** ADMIN: Add a student or mentor to a group. */
  @Post(':id/members')
  @Roles('ADMIN')
  addMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AddMemberDto,
    @Request() req: any,
  ) {
    return this.studyGroupsService.addMember(id, body, { id: req.user.id, role: req.user.role });
  }

  /** ADMIN: Change a member's group-scoped role. */
  @Patch(':id/members/:userId/role')
  @Roles('ADMIN')
  updateMemberRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: UpdateMemberRoleDto,
    @Request() req: any,
  ) {
    return this.studyGroupsService.updateMemberRole(
      id,
      userId,
      body,
      { id: req.user.id, role: req.user.role },
    );
  }

  /** ADMIN: Soft-remove a member from a group (preserves history). */
  @Delete(':id/members/:userId')
  @Roles('ADMIN')
  removeMember(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Request() req: any,
  ) {
    return this.studyGroupsService.removeMember(id, userId, { id: req.user.id, role: req.user.role });
  }

  /**
   * ADMIN: Full membership history including soft-removed records.
   * Useful for auditing who was ever in a group.
   */
  @Get(':id/members/history')
  @Roles('ADMIN')
  getMembershipHistory(@Param('id', ParseUUIDPipe) id: string) {
    return this.studyGroupsService.getMembershipHistory(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MEMBER / ADMIN — group content access
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ANY AUTHENTICATED + MEMBER (or ADMIN): View a single group and its
   * current active members.
   *
   * Authorization chain: JWT → GroupMemberGuard (Admin always passes).
   * Non-members get 403.
   */
  @Get(':id')
  @UseGuards(GroupMemberGuard)
  @Authenticated()
  findOne(@Param('id', ParseUUIDPipe) id: string, @Request() req: any) {
    return this.studyGroupsService.findOne(id, { id: req.user.id, role: req.user.role });
  }

  /**
   * ANY AUTHENTICATED: View own group memberships.
   * Returns only active groups the caller belongs to.
   */
  @Get('my/groups')
  @Authenticated()
  findMyGroups(@Request() req: any) {
    return this.studyGroupsService.findMyGroups(req.user.id);
  }
}
