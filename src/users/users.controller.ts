import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { UsersService } from './users.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  /** List users with optional filters. ADMIN only. */
  @Get()
  findAll(
    @Query('role')       role?: string,
    @Query('schoolId')   schoolId?: string,
    @Query('search')     search?: string,
    @Query('isApproved') isApproved?: string,
    @Query('page')       page?: string,
    @Query('limit')      limit?: string,
  ) {
    return this.usersService.findAll({
      role,
      schoolId,
      search,
      isApproved: isApproved === undefined ? undefined : isApproved === 'true',
      page:       page  ? parseInt(page,  10) : undefined,
      limit:      limit ? parseInt(limit, 10) : undefined,
    });
  }

  /**
   * Create a user directly (bypasses the mentor-request flow).
   * Role defaults to STUDENT; pass `role: "MENTOR"` or `role: "ADMIN"` to override.
   * ADMIN only.
   */
  @Post()
  create(@Body() body: CreateUserDto) {
    return this.usersService.create(body);
  }

  /** Get a single user by ID. ADMIN only. */
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  /** Update profile fields. ADMIN only. */
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateUserDto) {
    return this.usersService.update(id, body);
  }

  /** Delete a user. ADMIN only. */
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.usersService.delete(id);
  }

  /** Increment a student's points and problemsSolved counter. ADMIN only. */
  @Post(':id/progress')
  updateProgress(
    @Param('id') id: string,
    @Body('points') points: number,
  ) {
    return this.usersService.updateProgress(id, points);
  }
}
