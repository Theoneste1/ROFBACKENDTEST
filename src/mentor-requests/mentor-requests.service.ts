import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateMentorRequestDto } from './dto/create-mentor-request.dto.js';
import type { CallerCtx } from '../submissions/submissions.service.js';
import * as bcrypt from 'bcrypt';

@Injectable()
export class MentorRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ─── Submit a mentor application (public) ─────────────────────────────────
  async create(data: CreateMentorRequestDto) {
    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: data.username }, { email: data.email }],
      },
    });
    if (existingUser) {
      throw new BadRequestException('Username or email is already taken by an existing account.');
    }

    const existingRequest = await this.prisma.mentorRequest.findFirst({
      where: {
        OR: [{ username: data.username }, { email: data.email }],
      },
    });
    if (existingRequest) {
      throw new BadRequestException('A mentor request with this username or email already exists.');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    const request = await this.prisma.mentorRequest.create({
      data: {
        firstName:    data.firstName,
        lastName:     data.lastName,
        username:     data.username,
        email:        data.email,
        passwordHash,
      },
    });

    await this.audit.log({
      actorId:   null,
      actorRole: 'ANONYMOUS',
      action:    'SUBMIT_MENTOR_REQUEST',
      entity:    'MentorRequest',
      entityId:  request.id,
      metadata:  { username: data.username, email: data.email },
    });

    return {
      id:        request.id,
      firstName: request.firstName,
      lastName:  request.lastName,
      username:  request.username,
      email:     request.email,
      status:    request.status,
      createdAt: request.createdAt,
    };
  }

  // ─── ADMIN: List all mentor requests ──────────────────────────────────────
  async findAll() {
    return this.prisma.mentorRequest.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id:        true,
        firstName: true,
        lastName:  true,
        username:  true,
        email:     true,
        status:    true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // ─── ADMIN: Approve → creates a Mentor User account ───────────────────────
  async approve(requestId: string, caller: CallerCtx) {
    const request = await this.prisma.mentorRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new BadRequestException('Mentor request not found.');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('This mentor request has already been processed.');
    }

    const existingUser = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: request.username }, { email: request.email }],
      },
    });
    if (existingUser) {
      throw new BadRequestException(
        'A user with this username or email already exists.',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const mentor = await tx.user.create({
        data: {
          firstName:    request.firstName,
          lastName:     request.lastName,
          username:     request.username,
          email:        request.email,
          passwordHash: request.passwordHash,
          role:         'MENTOR',
        },
      });

      const updatedRequest = await tx.mentorRequest.update({
        where: { id: requestId },
        data:  { status: 'APPROVED' },
      });

      return { mentor, request: updatedRequest };
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'APPROVE_MENTOR_REQUEST',
      entity:    'MentorRequest',
      entityId:  requestId,
      metadata:  {
        newUserId: result.mentor.id,
        username:  result.mentor.username,
      },
    });

    return {
      mentor: {
        id:        result.mentor.id,
        firstName: result.mentor.firstName,
        lastName:  result.mentor.lastName,
        username:  result.mentor.username,
        email:     result.mentor.email,
        role:      result.mentor.role,
      },
      request: {
        id:     result.request.id,
        status: result.request.status,
      },
    };
  }

  // ─── ADMIN: Reject a mentor request ───────────────────────────────────────
  async reject(requestId: string, caller: CallerCtx) {
    const request = await this.prisma.mentorRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) {
      throw new BadRequestException('Mentor request not found.');
    }

    if (request.status !== 'PENDING') {
      throw new BadRequestException('This mentor request has already been processed.');
    }

    const updated = await this.prisma.mentorRequest.update({
      where: { id: requestId },
      data:  { status: 'REJECTED' },
    });

    await this.audit.log({
      actorId:   caller.id,
      actorRole: caller.role,
      action:    'REJECT_MENTOR_REQUEST',
      entity:    'MentorRequest',
      entityId:  requestId,
      metadata:  { username: request.username },
    });

    return {
      id:     updated.id,
      status: updated.status,
    };
  }
}
