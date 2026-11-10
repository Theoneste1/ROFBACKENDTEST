import {
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { CallerCtx } from '../common/auth-user.js';
import { BCRYPT_COST } from '../auth/auth.service.js';
import { ActivationService, type IssuedActivation } from '../auth/activation.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { Events } from '../notifications/events.js';
import { CreateMentorRequestDto, ListMentorRequestsDto } from './dto/create-mentor-request.dto.js';
import { ensureDefaultMembership } from '../programmes/programme-membership.js';

const PUBLIC_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true,
  status: true, createdAt: true, updatedAt: true,
} as const;

@Injectable()
export class MentorRequestsService {
  constructor(
    private readonly prisma:  PrismaService,
    private readonly audit:   AuditService,
    private readonly events:  EventEmitter2,
    private readonly activation: ActivationService,
    private readonly settings:   SettingsService,
  ) {}

  // ─── Submit a mentor application (public) ─────────────────────────────────
  //
  // A previously REJECTED applicant may apply again with the same details;
  // the old request is reused.
  async create(data: CreateMentorRequestDto) {
    const [existingUser, existingRequest] = await Promise.all([
      this.prisma.user.findFirst({
        where:  { OR: [{ username: data.username }, { email: data.email }] },
        select: { id: true },
      }),
      this.prisma.mentorRequest.findFirst({
        where: { OR: [{ username: data.username }, { email: data.email }] },
      }),
    ]);

    // One generic message: the endpoint must not reveal which part is taken.
    const taken = () =>
      new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');

    if (existingUser) throw taken();
    if (existingRequest && existingRequest.status !== 'REJECTED') throw taken();

    const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);
    const fields = {
      firstName: data.firstName,
      lastName:  data.lastName,
      username:  data.username,
      email:     data.email,
      passwordHash,
      status:    'PENDING' as const,
    };

    const request = existingRequest
      ? await this.prisma.mentorRequest.update({ where: { id: existingRequest.id }, data: fields, select: PUBLIC_SELECT })
      : await this.prisma.mentorRequest.create({ data: fields, select: PUBLIC_SELECT });

    await this.audit.log({
      actorId: null, actorRole: 'ANONYMOUS',
      action: 'SUBMIT_MENTOR_REQUEST', entity: 'MentorRequest', entityId: request.id,
      metadata: { reapplication: !!existingRequest },
    });

    return request;
  }

  // ─── ADMIN: List requests ─────────────────────────────────────────────────
  async findAll(q: ListMentorRequestsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where = q.status ? { status: q.status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.mentorRequest.findMany({ where, select: PUBLIC_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.mentorRequest.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  // ─── ADMIN: Approve → creates a Mentor account ────────────────────────────
  //
  // With e-mail verification on (the production default), the account is
  // created unactivated and the applicant must confirm the address before the
  // first login — so nobody can apply in someone else's name.
  async approve(requestId: string, caller: CallerCtx) {
    const request = await this.requireRequest(requestId);
    const verify = await this.settings.get('registration.requireEmailVerification');

    let issued: IssuedActivation | null = null;
    const result = await this.prisma.$transaction(async (tx) => {
      // Claim the request: only one concurrent approval can succeed.
      const { count } = await tx.mentorRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data:  { status: 'APPROVED', passwordHash: null },
      });
      if (count === 0) throw invalidState('This coach application has already been processed.');

      const clash = await tx.user.findFirst({
        where:  { OR: [{ username: request.username }, { email: request.email }] },
        select: { id: true },
      });
      if (clash) {
        throw new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'A user with this username or email already exists.');
      }

      const mentor = await tx.user.create({
        data: {
          firstName:    request.firstName,
          lastName:     request.lastName,
          username:     request.username,
          email:        request.email,
          passwordHash: request.passwordHash,
          role:         'MENTOR',
          // The applicant chose this password; the address may still need confirming.
          activatedAt:  verify ? null : new Date(),
        },
        select: { id: true, firstName: true, lastName: true, username: true, email: true, role: true },
      });
      await ensureDefaultMembership(tx, mentor, caller.id);   // approved coach (P1-07, K6)
      if (verify) issued = await this.activation.issue(mentor.id, 'EMAIL_VERIFICATION', caller.id, tx);

      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'APPROVE_MENTOR_REQUEST', entity: 'MentorRequest', entityId: requestId,
        metadata: { newUserId: mentor.id },
      }, tx);

      return mentor;
    });

    if (issued) {
      // The confirmation e-mail doubles as the approval notice.
      await this.activation.send(issued);
    } else {
      this.events.emit(Events.MentorRequestDecided, {
        email: request.email, firstName: request.firstName, approved: true,
      });
    }

    return {
      mentor:  result,
      request: { id: requestId, status: 'APPROVED' },
      emailVerificationRequired: verify,
      next:    'Assign the mentor to courses and divisions via POST /api/v1/admin/mentor-assignments.',
    };
  }

  // ─── ADMIN: Reject ────────────────────────────────────────────────────────
  async reject(requestId: string, caller: CallerCtx) {
    const request = await this.requireRequest(requestId);

    const { count } = await this.prisma.mentorRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data:  { status: 'REJECTED', passwordHash: null },
    });
    if (count === 0) throw invalidState('This coach application has already been processed.');

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'REJECT_MENTOR_REQUEST', entity: 'MentorRequest', entityId: requestId,
    });

    this.events.emit(Events.MentorRequestDecided, {
      email: request.email, firstName: request.firstName, approved: false,
    });

    return { id: requestId, status: 'REJECTED' };
  }

  private async requireRequest(id: string) {
    const request = await this.prisma.mentorRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Coach application not found.');
    return request;
  }
}
