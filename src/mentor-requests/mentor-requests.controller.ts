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
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { ApiBody, ApiTags } from '@nestjs/swagger';

import { MentorRequestsService } from './mentor-requests.service.js';
import { ApproveMentorRequestDto, CreateMentorRequestDto, ListMentorRequestsDto, RejectMentorRequestDto } from './dto/create-mentor-request.dto.js';
import { RegistrationAvatarService } from '../users/registration-avatar.service.js';
import { RequestApplicationInfoDto } from '../application-info-requests/application-info-requests.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Mentor requests')
@Controller('mentor-requests')
export class MentorRequestsController {
  constructor(
    private readonly mentorRequestsService: MentorRequestsService,
    private readonly registrationAvatar: RegistrationAvatarService,
  ) {}

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
  // The body is optional: { approvePicture: true } keeps the application's picture (picture moderation).
  @ApiBody({ type: ApproveMentorRequestDto, required: false })
  approve(@Param('id', ParseUUIDPipe) id: string, @Body() body: ApproveMentorRequestDto, @CurrentUser() user: AuthUser) {
    return this.mentorRequestsService.approve(id, user, { approvePicture: body?.approvePicture });
  }

  /** The picture sent with the application, for review before approval (private, not cached). 404 when none. */
  @Get(':id/avatar')
  @RequirePermission('mentorRequests.decide')
  async avatar(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    await this.registrationAvatar.sendApplicationAvatar('COACH', id, res);
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
