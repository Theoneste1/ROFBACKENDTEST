import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';

import { MentorRequestsService } from './mentor-requests.service.js';
import { CreateMentorRequestDto } from './dto/create-mentor-request.dto.js';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

@Controller('mentor-requests')
export class MentorRequestsController {
  constructor(private readonly mentorRequestsService: MentorRequestsService) {}

  // ─── Public: submit a mentor application ──────────────────────────────────
  @Post()
  async create(@Body() body: CreateMentorRequestDto) {
    return this.mentorRequestsService.create(body);
  }

  // ─── ADMIN: list all requests ──────────────────────────────────────────────
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async findAll() {
    return this.mentorRequestsService.findAll();
  }

  // ─── ADMIN: approve ────────────────────────────────────────────────────────
  @Patch(':id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async approve(@Param('id') id: string, @Request() req: any) {
    return this.mentorRequestsService.approve(id, { id: req.user.id, role: req.user.role });
  }

  // ─── ADMIN: reject ─────────────────────────────────────────────────────────
  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async reject(@Param('id') id: string, @Request() req: any) {
    return this.mentorRequestsService.reject(id, { id: req.user.id, role: req.user.role });
  }
}
