import { homePlaceText, resolveHomePlace } from '../common/home-place.js';
import {
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service.js';
import { FormAvailabilityService } from '../forms/form-availability.service.js';
import { AuditService } from '../audit/audit.service.js';
import { AppError, invalidState } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { MentorRequestStatus, Prisma } from '../generated/prisma/client.js';
import type { CallerCtx } from '../common/auth-user.js';
import { BCRYPT_COST } from '../auth/auth.service.js';
import { ActivationService, type IssuedActivation } from '../auth/activation.service.js';
import { Events } from '../notifications/events.js';
import { CreateMentorRequestDto, ListMentorRequestsDto } from './dto/create-mentor-request.dto.js';
import { ensureDefaultMembership } from '../programmes/programme-membership.js';
import { canonicalInterests } from '../users/olympiad-interests.js';
import { DecisionNotificationsService } from '../decision-notifications/decision-notifications.service.js';
import { DecisionEvents } from '../decision-notifications/decision-content.js';
import { ApplicationInfoRequestsService, INFO_REQUEST_SELECT } from '../application-info-requests/application-info-requests.service.js';
import { normalisePhone } from '../schools/directory/school-contacts.js';
import { RegistrationAvatarService, carryApplicationAvatar } from '../users/registration-avatar.service.js';
import { storedOtherInterest } from '../users/olympiad-interests.rules.js';

const PUBLIC_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true,
  status: true, createdAt: true, updatedAt: true,
  // Application details (coachApplicationDetails); NULL / empty on older applications.
  country: true, occupation: true, educationLevel: true, olympiadInterests: true, olympiadInterestOther: true,
  // REG-06 / REG-10 (2026-11-17)
  phone: true, affiliation: true, expertise: true, relevantExperience: true, yearsOfExperience: true, rejectionReason: true,
  infoRequests: { select: INFO_REQUEST_SELECT, orderBy: { requestedAt: 'desc' }, take: 10 },
  // Whether a picture was sent (Administrators review it before approving: GET /mentor-requests/:id/avatar).
  avatarFileId: true,
} as const;

/**
 * What the PUBLIC submit returns: the applicant's own submitted fields only — never an info-request history (each
 * attempt is its own row; defence in depth).
 */
const { infoRequests: _history, avatarFileId: _picture, ...SUBMIT_SELECT } = PUBLIC_SELECT;

@Injectable()
export class MentorRequestsService {
  constructor(
    private readonly prisma:  PrismaService,
    private readonly audit:   AuditService,
    private readonly events:  EventEmitter2,
    private readonly activation: ActivationService,
    private readonly notices:    DecisionNotificationsService,
    private readonly forms:      FormAvailabilityService,
    private readonly infoRequests: ApplicationInfoRequestsService,
    private readonly registrationAvatar: RegistrationAvatarService,
  ) {}

  // ─── Submit a mentor application (public) ─────────────────────────────────
  //
  // A previously REJECTED applicant may apply again with the same details. Every attempt is its own row: the
  // rejected attempt (with its questions, answers and decision) is kept as it was, and never becomes part of the new
  // application — whoever submits it.
  async create(data: CreateMentorRequestDto) {
    // The COACH_APPLICATION form: 403 FORM_CLOSED with its closed message while it is not open.
    await this.forms.assertOpen('COACH_APPLICATION');
    const [existingUser, existingRequest, pendingTeacherApplication] = await Promise.all([
      this.prisma.user.findFirst({
        where:  { OR: [{ username: data.username }, { email: data.email }] },
        select: { id: true },
      }),
      // Only an application that is not REJECTED holds the username and e-mail (partial unique indexes).
      this.prisma.mentorRequest.findFirst({
        where: { OR: [{ username: data.username }, { email: data.email }], status: { not: 'REJECTED' } },
        select: { id: true },
      }),
      // A pending Teacher application holds its username and e-mail too (teacher self-registration).
      this.prisma.teacherApplication.findFirst({
        where:  { OR: [{ username: data.username }, { email: data.email }], status: 'PENDING' },
        select: { id: true },
      }),
    ]);

    // One generic message: the endpoint must not reveal which part is taken.
    const taken = () =>
      new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');

    if (existingUser || pendingTeacherApplication) throw taken();
    if (existingRequest) throw taken();
    const reapplication = (await this.prisma.mentorRequest.count({
      where: { OR: [{ username: data.username }, { email: data.email }], status: 'REJECTED' },
    })) > 0;

    const phone = data.phone === undefined ? null : normalisePhone(data.phone);
    if (data.phone !== undefined && !phone) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_PHONE', 'Enter a valid phone number (Rwanda: 07XXXXXXXX or +2507XXXXXXXX; elsewhere: +country number).');
    }
    // Home location (homeLocationRules): the official place for Rwanda, nothing for another home country.
    const home = await resolveHomePlace(this.prisma, data.country, data);
    const passwordHash = await bcrypt.hash(data.password, BCRYPT_COST);
    const fields = {
      firstName: data.firstName,
      lastName:  data.lastName,
      username:  data.username,
      email:     data.email,
      passwordHash,
      status:    'PENDING' as const,
      // Application details (coachApplicationDetails); a reapplication replaces the earlier ones.
      country:           data.country,
      homeProvince:      home.homeProvince,
      homeDistrict:      home.homeDistrict,
      homeSector:        home.homeSector,
      gender:            data.gender,
      occupation:        data.occupation ?? null,
      educationLevel:    data.educationLevel ?? null,
      olympiadInterests: canonicalInterests(data.olympiadInterests),
      olympiadInterestOther: storedOtherInterest(data.olympiadInterestOther) ?? null,
      phone, affiliation: data.affiliation ?? null, expertise: data.expertise ?? null,
      relevantExperience: data.relevantExperience ?? null, yearsOfExperience: data.yearsOfExperience ?? null,
      rejectionReason: null,
    };

    // A concurrent submission with the same username or e-mail loses on the partial unique index: the same answer.
    const request = await this.prisma.mentorRequest.create({ data: fields, select: SUBMIT_SELECT }).catch((e: unknown) => {
      if ((e as { code?: string })?.code === 'P2002') throw taken();
      throw e;
    });

    await this.audit.log({
      actorId: null, actorRole: 'ANONYMOUS',
      action: 'SUBMIT_MENTOR_REQUEST', entity: 'MentorRequest', entityId: request.id,
      metadata: { reapplication },
    });
    this.events.emit(Events.MentorRequestSubmitted, {
      requestId: request.id, submittedAt: request.updatedAt.toISOString(), reapplication,
    });

    // OPTIONAL picture (REG-02): PUT /auth/register/avatar within 30 minutes.
    return { ...request, avatarUploadToken: this.registrationAvatar.issue('COACH_APPLICATION', request.id) };
  }

  // ─── ADMIN: List requests ─────────────────────────────────────────────────
  async findAll(q: ListMentorRequestsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where = mentorRequestListWhere(q);
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
  async approve(requestId: string, caller: CallerCtx, opts: { approvePicture?: boolean } = {}) {
    await this.requireRequest(requestId);
    const verify = await this.forms.requiresEmailVerification('COACH_APPLICATION');
    const { mentor: result, issued, notice } = await this.prisma.$transaction((tx) => this.approveInTx(tx, requestId, caller, opts, verify));

    // With e-mail verification on, the confirmation e-mail is still sent; the approval notice (which replaces
    // the former MentorRequestDecided approval e-mail) tells the coach to use it before logging in.
    this.notices.dispatchAfterCommit([notice]);
    if (issued) await this.activation.send(issued);

    return {
      mentor:  result,
      request: { id: requestId, status: 'APPROVED' },
      emailVerificationRequired: verify,
      next:    'Assign the mentor to courses and divisions via POST /api/v1/admin/mentor-assignments.',
    };
  }

  /**
   * approve() inside the caller's transaction (also each record of a COACH_APPLICATION bulk approve; ctx.operationId
   * audited). Returns the account, the activation to send and the notice to dispatch once the transaction committed.
   */
  async approveInTx(
    tx: Prisma.TransactionClient, requestId: string, caller: CallerCtx, opts: { approvePicture?: boolean }, verify: boolean,
    ctx: { operationId?: string } = {},
  ) {
    // The row as it is now, locked (an answer to a request for more information may have corrected it; the answer
    // path locks the application first too). Read before the claim, which clears the password hash.
    await tx.$queryRaw`SELECT 1 FROM "MentorRequest" WHERE "id" = ${requestId} FOR UPDATE`;
    const request = await tx.mentorRequest.findUniqueOrThrow({ where: { id: requestId } });
    // Claim the request: only one concurrent approval can succeed. The picture moves to the account (below).
    const { count } = await tx.mentorRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data:  { status: 'APPROVED', passwordHash: null, avatarFileId: null },
    });
    if (count === 0) throw invalidState('This coach application has already been processed.');
    await this.infoRequests.cancelOpen(tx, 'COACH', requestId);

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
        // From the application (coachApplicationDetails): information only, no permissions.
        country:           request.country,
        gender:            request.gender,
        // Home location (homeLocationRules): the place in Rwanda ("Sector, District" for existing displays).
        homeProvince:      request.homeProvince,
        homeDistrict:      request.homeDistrict,
        homeSector:        request.homeSector,
        homeLocation:      homePlaceText(request),
        olympiadInterests: request.olympiadInterests,
        olympiadInterestOther: request.olympiadInterestOther,
        // The applicant chose this password; the address may still need confirming.
        activatedAt:  verify ? null : new Date(),
      },
      select: { id: true, firstName: true, lastName: true, username: true, email: true, role: true },
    });
    // Picture moderation: only a picture the Administrator approved after seeing it (else discarded, cleaned up).
    const picture = !request.avatarFileId ? 'NONE' : opts.approvePicture === true ? 'APPROVED' : 'DISCARDED';
    if (picture === 'APPROVED') await carryApplicationAvatar(tx, mentor.id, request.avatarFileId);   // REG-02
    await ensureDefaultMembership(tx, mentor, caller.id);   // approved coach (P1-07, K6)
    const issued: IssuedActivation | null = verify ? await this.activation.issue(mentor.id, 'EMAIL_VERIFICATION', caller.id, tx) : null;

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'APPROVE_MENTOR_REQUEST', entity: 'MentorRequest', entityId: requestId,
      metadata: { newUserId: mentor.id, picture, ...(ctx.operationId && { operationId: ctx.operationId }) },
    }, tx);
    // The one approval notice (e-mail + in-app), written with the approval (decision notifications).
    const notice = await this.notices.enqueue(tx, {
      type: DecisionEvents.CoachApplicationApproved, dedupeKey: `${DecisionEvents.CoachApplicationApproved}:${requestId}`,
      recipient: { userId: mentor.id, email: mentor.email, firstName: request.firstName },
      entity: { type: 'MentorRequest', id: requestId }, payload: { activated: !verify },
    });

    return { mentor, issued, notice };
  }

  // ─── ADMIN: Reject ────────────────────────────────────────────────────────
  /** Ask the applicant for more information (ADR-009): the application stays PENDING; e-mailed one-time link. */
  async requestInfo(requestId: string, question: string, caller: CallerCtx) {
    await this.infoRequests.request('COACH', requestId, question, caller);
    return this.prisma.mentorRequest.findUniqueOrThrow({ where: { id: requestId }, select: PUBLIC_SELECT });
  }

  async reject(requestId: string, caller: CallerCtx, reason?: string) {
    const request = await this.requireRequest(requestId);
    await this.prisma.$transaction((tx) => this.rejectInTx(tx, requestId, caller, reason));
    this.rejectionNotice(request, reason);
    return { id: requestId, status: 'REJECTED' };
  }

  /**
   * reject() inside the caller's transaction (also each record of a COACH_APPLICATION bulk reject; ctx.operationId
   * audited): only a PENDING application (409 INVALID_STATE_TRANSITION otherwise); the decision and its audit row
   * commit together. The applicant's e-mail (rejectionNotice) is the caller's, after commit.
   */
  async rejectInTx(tx: Prisma.TransactionClient, requestId: string, caller: CallerCtx, reason?: string, ctx: { operationId?: string } = {}) {
    const r = await tx.mentorRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      // A rejected application keeps no picture (the file is then cleaned up as an orphan).
      data:  { status: 'REJECTED', passwordHash: null, rejectionReason: reason ?? null, avatarFileId: null },
    });
    if (r.count === 0) throw invalidState('This coach application has already been processed.');
    await this.infoRequests.cancelOpen(tx, 'COACH', requestId);
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'REJECT_MENTOR_REQUEST', entity: 'MentorRequest', entityId: requestId,
      ...((reason || ctx.operationId) && { metadata: { ...(reason && { reason }), ...(ctx.operationId && { operationId: ctx.operationId }) } }),
    }, tx);
  }

  /** The applicant learns the decision (and the reason, when one was given), after it committed. */
  rejectionNotice(request: { email: string; firstName: string }, reason?: string) {
    this.events.emit(Events.MentorRequestDecided, {
      email: request.email, firstName: request.firstName, approved: false, ...(reason && { reason }),
    });
  }

  private async requireRequest(id: string) {
    const request = await this.prisma.mentorRequest.findUnique({ where: { id } });
    if (!request) throw new NotFoundException('Coach application not found.');
    return request;
  }
}

/** The filters of GET /mentor-requests (and of the COACH_APPLICATION bulk selection). */
export function mentorRequestListWhere(q: { status?: MentorRequestStatus }): Prisma.MentorRequestWhereInput {
  return q.status ? { status: q.status } : {};
}
