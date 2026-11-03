import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { UsersService } from './users.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import {
  ListUsersQueryDto,
  UpdateMeDto,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './dto/update-user.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { permissionsFor } from '../auth/permissions.js';

@ApiTags('Admin · Users')
@Controller('admin/users')
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** List users with filters (role, division, grade, school, status, search). */
  @Get()
  findAll(@Query() query: ListUsersQueryDto) {
    return this.usersService.findAll(query);
  }

  /** Create a student, mentor or admin directly. Students require a gradeLevel. */
  @Post()
  create(@Body() body: CreateUserDto, @CurrentUser() user: AuthUser) {
    return this.usersService.create(body, user);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.usersService.update(id, body, user);
  }

  /** Suspend/reactivate (`isActive`) or approve (`isApproved`) an account. */
  @Patch(':id/status')
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateUserStatusDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.usersService.updateStatus(id, body, user);
  }

  /** Only accounts without academic history can be deleted; suspend the others. */
  @Delete(':id')
  delete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.usersService.delete(id, user);
  }
}

@ApiTags('Me')
@Controller('me')
export class MeController {
  constructor(private readonly usersService: UsersService) {}

  /** The current user's profile, division and school. */
  @Get()
  getMe(@CurrentUser() user: AuthUser) {
    return this.usersService.getMe(user.id);
  }

  @Patch()
  updateMe(@CurrentUser() user: AuthUser, @Body() body: UpdateMeDto) {
    return this.usersService.updateMe(user.id, body);
  }

  /** What the current user's role may do (for showing/hiding UI). */
  @Get('permissions')
  permissions(@CurrentUser() user: AuthUser) {
    return { role: user.role, permissions: permissionsFor(user.role) };
  }

  /** The current student's enrolment history (one row per academic year). */
  @Get('enrollments')
  @Roles('STUDENT')
  enrollments(@CurrentUser() user: AuthUser) {
    return this.usersService.getMyEnrollments(user.id);
  }
}
