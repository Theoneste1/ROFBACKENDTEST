import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { LiveSessionsService } from './live-sessions.service.js';
import {
  CancelLiveSessionDto,
  CreateLiveSessionDto,
  ListLiveSessionsDto,
  UpdateLiveSessionDto,
} from './dto/live-session.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Live sessions')
@Controller('live-sessions')
export class LiveSessionsController {
  constructor(private readonly service: LiveSessionsService) {}

  /** Schedule an external live session for a course × division you teach. */
  @Post()
  @Roles('MENTOR', 'ADMIN')
  create(@Body() body: CreateLiveSessionDto, @CurrentUser() user: AuthUser) {
    return this.service.create(body, user);
  }

  /** Upcoming sessions by default; `?upcoming=false` for history. */
  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListLiveSessionsDto) {
    return this.service.findAll(user, query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.service.findOne(id, user);
  }

  @Patch(':id')
  @Roles('MENTOR', 'ADMIN')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLiveSessionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.update(id, body, user);
  }

  @Post(':id/cancel')
  @Roles('MENTOR', 'ADMIN')
  @HttpCode(200)
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CancelLiveSessionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.cancel(id, body, user);
  }
}
