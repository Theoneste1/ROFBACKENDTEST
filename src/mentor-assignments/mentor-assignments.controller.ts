import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { MentorAssignmentsService } from './mentor-assignments.service.js';
import { CreateMentorAssignmentDto, ListMentorAssignmentsDto } from './dto/mentor-assignment.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

/**
 * Coach course × division assignments (mentorAssignments.manage): Administrators
 * everywhere; a Head Coach only for Coaches who are members of a programme they
 * head, on that programme's courses — never themselves or another Head Coach (H3, H4).
 */
@ApiTags('Admin · Mentor assignments')
@Controller('admin/mentor-assignments')
export class MentorAssignmentsController {
  constructor(private readonly service: MentorAssignmentsService) {}

  @Get()
  @RequirePermission('mentorAssignments.manage')
  findAll(@Query() query: ListMentorAssignmentsDto, @CurrentUser() user: AuthUser) {
    return this.service.findAll(query, user);
  }

  /** Assign a mentor to a course × division (re-activates a previous assignment). */
  @Post()
  @RequirePermission('mentorAssignments.manage')
  assign(@Body() body: CreateMentorAssignmentDto, @CurrentUser() user: AuthUser) {
    return this.service.assign(body, user);
  }

  /** Deactivate. The response reports open reviews that should be reassigned. */
  @Delete(':id')
  @RequirePermission('mentorAssignments.manage')
  unassign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.unassign(id, user);
  }
}

@ApiTags('Me')
@Controller('me/teaching')
@Roles('MENTOR', 'HEAD_COACH')
export class MyTeachingController {
  constructor(private readonly service: MentorAssignmentsService) {}

  /** Course × division pairs the current coach (or Head Coach, H4) is assigned to. */
  @Get()
  findMine(@CurrentUser() user: AuthUser) {
    return this.service.findMine(user.id);
  }
}
