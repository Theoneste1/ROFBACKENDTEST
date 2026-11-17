import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiBody, ApiTags } from '@nestjs/swagger';

import { MentorRequestsService } from './mentor-requests.service.js';
import { CreateMentorRequestDto, ListMentorRequestsDto, RejectMentorRequestDto } from './dto/create-mentor-request.dto.js';
import { RequestApplicationInfoDto } from '../application-info-requests/application-info-requests.dto.js';
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
  // The body is optional: older clients send none (no reason).
  @ApiBody({ type: RejectMentorRequestDto, required: false })
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: RejectMentorRequestDto, @CurrentUser() user: AuthUser) {
    return this.mentorRequestsService.reject(id, user, body?.reason);
  }

  // ─── ADMIN: request more information (ADR-009); the application stays PENDING ───
  @Post(':id/request-info')
  @HttpCode(200)
  @RequirePermission('mentorRequests.decide')
  requestInfo(@Param('id', ParseUUIDPipe) id: string, @Body() body: RequestApplicationInfoDto, @CurrentUser() user: AuthUser) {
    return this.mentorRequestsService.requestInfo(id, body.question, user);
  }
}
