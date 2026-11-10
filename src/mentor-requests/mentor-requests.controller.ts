import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';

import { MentorRequestsService } from './mentor-requests.service.js';
import { CreateMentorRequestDto, ListMentorRequestsDto } from './dto/create-mentor-request.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Mentor requests')
@Controller('mentor-requests')
export class MentorRequestsController {
  constructor(private readonly mentorRequestsService: MentorRequestsService) {}

  // ─── Public: submit a mentor application ──────────────────────────────────
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  create(@Body() body: CreateMentorRequestDto) {
    return this.mentorRequestsService.create(body);
  }

  // ─── ADMIN: list requests (filter with ?status=PENDING) ────────────────────
  @Get()
  @RequirePermission('mentorRequests.decide')
  findAll(@Query() query: ListMentorRequestsDto) {
    return this.mentorRequestsService.findAll(query);
  }

  // ─── ADMIN: approve (creates the mentor account) ───────────────────────────
  @Patch(':id/approve')
  @RequirePermission('mentorRequests.decide')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.mentorRequestsService.approve(id, user);
  }

  // ─── ADMIN: reject ─────────────────────────────────────────────────────────
  @Patch(':id/reject')
  @RequirePermission('mentorRequests.decide')
  reject(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.mentorRequestsService.reject(id, user);
  }
}
