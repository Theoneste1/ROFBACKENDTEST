import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { MentorAssignmentsService } from './mentor-assignments.service.js';
import { CreateMentorAssignmentDto, ListMentorAssignmentsDto } from './dto/mentor-assignment.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Admin · Mentor assignments')
@Controller('admin/mentor-assignments')
@Roles('ADMIN', 'SUPER_ADMIN')
export class MentorAssignmentsController {
  constructor(private readonly service: MentorAssignmentsService) {}

  @Get()
  findAll(@Query() query: ListMentorAssignmentsDto) {
    return this.service.findAll(query);
  }

  /** Assign a mentor to a course × division (re-activates a previous assignment). */
  @Post()
  assign(@Body() body: CreateMentorAssignmentDto, @CurrentUser() user: AuthUser) {
    return this.service.assign(body, user);
  }

  /** Deactivate. The response reports open reviews that should be reassigned. */
  @Delete(':id')
  unassign(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.unassign(id, user);
  }
}

@ApiTags('Me')
@Controller('me/teaching')
@Roles('MENTOR')
export class MyTeachingController {
  constructor(private readonly service: MentorAssignmentsService) {}

  /** Course × division pairs the current mentor is assigned to. */
  @Get()
  findMine(@CurrentUser() user: AuthUser) {
    return this.service.findMine(user.id);
  }
}
