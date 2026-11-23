/**
 * Marker authorisations (Test Management WS3, Phase 1): which coaches may mark a subject's tests (marking itself arrives
 * in Phase 3, which checks an ACTIVE authorisation AND an assignment on every request).
 *
 *   - granted and revoked by an Administrator (every subject) or one of the subject's Head Coaches (only subjects they
 *     head; only coaches who are active members of that subject — coaches join a programme through an Administrator);
 *   - only ACTIVE Coach (MENTOR) accounts can be authorised; at most one active authorisation per coach and subject
 *     (serialised per pair, with the partial unique index as the backstop);
 *   - a revocation needs a reason and keeps the row (history); both are audited in the same transaction;
 *   - a coach's olympiadInterests are shown as a hint only: an interest NEVER grants marking.
 */
import { HttpStatus, Injectable } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { AccessService, scopeForbidden } from '../common/access/access.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { GrantMarkerDto, ListMarkersQueryDto, MarkerCandidatesQueryDto, RevokeMarkerDto } from './dto/test.dto.js';
import { assertSubjectInScope, subjectFilter, type SubjectScope } from './test-rules.js';

const PERSON = { select: { id: true, username: true, firstName: true, lastName: true } } as const;
const AUTH_INCLUDE = {
  coach:      { select: { id: true, username: true, firstName: true, lastName: true, accountStatus: true, olympiadInterests: true } },
  discipline: { select: { id: true, code: true, name: true } },
  grantedBy:  PERSON,
  revokedBy:  PERSON,
} as const satisfies Prisma.MarkerAuthorizationInclude;
type AuthRow = Prisma.MarkerAuthorizationGetPayload<{ include: typeof AUTH_INCLUDE }>;

const notFound = () => new AppError(HttpStatus.NOT_FOUND, 'MARKER_AUTHORIZATION_NOT_FOUND', 'Marker authorisation not found.');

@Injectable()
export class TestMarkersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  private scope(user: AuthUser): Promise<SubjectScope> {
    return this.access.programmeScope(user);
  }

  async list(q: ListMarkersQueryDto, user: AuthUser) {
    const scope = await this.scope(user);
    if (q.subjectId) assertSubjectInScope(scope, q.subjectId);
    const state = q.state ?? 'active';
    const where: Prisma.MarkerAuthorizationWhereInput = {
      ...subjectFilter(scope),
      ...(q.subjectId && { disciplineId: q.subjectId }),
      ...(state === 'active' && { revokedAt: null }),
      ...(state === 'revoked' && { revokedAt: { not: null } }),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.markerAuthorization.findMany({
        where, include: AUTH_INCLUDE, skip, take,
        orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { coach: { lastName: 'asc' } }, { coach: { firstName: 'asc' } }, { id: 'asc' }],
      }),
      this.prisma.markerAuthorization.count({ where }),
    ]);
    return paginated(rows.map(authView), total, page, limit);
  }

  /**
   * Coaches who could be authorised for the subject: ACTIVE Coach accounts (for a Head Coach, only active members of that
   * subject's programme), with whether they are already authorised and whether they declared an interest in it.
   */
  async candidates(q: MarkerCandidatesQueryDto, user: AuthUser) {
    const scope = await this.scope(user);
    const subject = await this.requireSubject(q.subjectId);
    assertSubjectInScope(scope, subject.id);
    const where: Prisma.UserWhereInput = {
      role: 'MENTOR', accountStatus: 'ACTIVE',
      ...(scope !== 'all' && { programmeMemberships: { some: { disciplineId: subject.id, isActive: true } } }),
      ...(q.q && { OR: [
        { firstName: { contains: q.q, mode: 'insensitive' } },
        { lastName:  { contains: q.q, mode: 'insensitive' } },
        { username:  { contains: q.q, mode: 'insensitive' } },
      ] }),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: {
          id: true, username: true, firstName: true, lastName: true, olympiadInterests: true,
          markerAuthorizations: { where: { disciplineId: subject.id, revokedAt: null }, select: { id: true } },
          programmeMemberships: { where: { disciplineId: subject.id, isActive: true }, select: { id: true } },
          coachRestrictions: { where: { disciplineId: subject.id, capability: 'MARKING', liftedAt: null }, select: { id: true, reason: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(rows.map((u) => ({
      id: u.id, username: u.username, firstName: u.firstName, lastName: u.lastName,
      /** A hint only: an interest never grants marking. */
      interestedInSubject: (u.olympiadInterests as string[]).includes(subject.code),
      authorizationId: u.markerAuthorizations[0]?.id ?? null,
      /** Owner 2026-11-23: a member of the subject's programme marks by default (no authorisation needed). */
      programmeMember: u.programmeMemberships.length > 0,
      /** Marking taken away from this coach in this subject (reason shown); authorising gives it back. */
      markingRemoved: u.coachRestrictions[0] ? { id: u.coachRestrictions[0].id, reason: u.coachRestrictions[0].reason } : null,
      mayMark: (u.markerAuthorizations.length > 0 || u.programmeMemberships.length > 0) && u.coachRestrictions.length === 0,
    })), total, page, limit);
  }

  async grant(dto: GrantMarkerDto, user: AuthUser) {
    const scope = await this.scope(user);
    const subject = await this.requireSubject(dto.subjectId);
    assertSubjectInScope(scope, subject.id);
    const coach = await this.prisma.user.findUnique({ where: { id: dto.coachId }, select: { id: true, role: true, accountStatus: true } });
    if (!coach || coach.role !== 'MENTOR') {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_COACH', 'Only Coach accounts can be authorised to mark.', { coachId: dto.coachId });
    }
    if (coach.accountStatus !== 'ACTIVE') {
      throw new AppError(HttpStatus.CONFLICT, 'ACCOUNT_NOT_ACTIVE', 'This coach account is not active.', { accountStatus: coach.accountStatus });
    }
    if (scope !== 'all' && !(await this.access.isProgrammeMember(coach.id, subject.id))) {
      throw scopeForbidden('A Head Coach authorises coaches of the subject only; an Administrator adds a coach to the subject.', { coachId: coach.id });
    }

    const id = await this.prisma.$transaction(async (tx) => {
      // One decision at a time per (coach, subject); the partial unique index is the backstop.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`marker:${coach.id}:${subject.id}`}))`;
      const active = await tx.markerAuthorization.findFirst({ where: { coachId: coach.id, disciplineId: subject.id, revokedAt: null }, select: { id: true } });
      if (active) {
        throw new AppError(HttpStatus.CONFLICT, 'MARKER_ALREADY_AUTHORIZED', 'This coach is already authorised to mark this subject.', { authorizationId: active.id });
      }
      const row = await tx.markerAuthorization.create({
        data: { coachId: coach.id, disciplineId: subject.id, grantedById: user.id, grantReason: dto.reason ?? null },
        select: { id: true },
      });
      // Authorising gives marking back: a MARKING restriction of this coach in this subject is lifted (marker-reach.ts).
      await liftMarkingRestriction(tx, coach.id, subject.id, user, dto.reason ?? 'Authorised to mark again');
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'MARKER_AUTHORIZED', entity: 'MarkerAuthorization', entityId: row.id,
        metadata: { coachId: coach.id, subjectId: subject.id, subjectCode: subject.code, reason: dto.reason ?? null },
      }, tx);
      return row.id;
    });
    return this.view(id);
  }

  async revoke(id: string, dto: RevokeMarkerDto, user: AuthUser) {
    const scope = await this.scope(user);
    const found = await this.prisma.markerAuthorization.findUnique({ where: { id }, select: { disciplineId: true } });
    if (!found) throw notFound();
    assertSubjectInScope(scope, found.disciplineId);
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const done = await tx.markerAuthorization.updateMany({
        where: { id, revokedAt: null },
        data:  { revokedAt: now, revokedById: user.id, revokeReason: dto.reason },
      });
      if (done.count === 0) {
        throw new AppError(HttpStatus.CONFLICT, 'MARKER_AUTHORIZATION_REVOKED', 'This authorisation was already revoked.');
      }
      const row = await tx.markerAuthorization.findUniqueOrThrow({ where: { id }, select: { coachId: true, disciplineId: true } });
      // A member of the subject's programme would still mark by default (owner 2026-11-23): revoking takes that away too,
      // so "revoked" means the coach no longer marks this subject (CoachProgrammeRestriction MARKING, same reason).
      const member = await tx.programmeMembership.count({ where: { userId: row.coachId, disciplineId: row.disciplineId, isActive: true } });
      const restricted = member ? await restrictMarking(tx, row.coachId, row.disciplineId, user, dto.reason) : null;
      await this.audit.log({
        actorId: user.id, actorRole: user.role, action: 'MARKER_AUTHORIZATION_REVOKED', entity: 'MarkerAuthorization', entityId: id,
        metadata: { coachId: row.coachId, subjectId: row.disciplineId, reason: dto.reason, ...(restricted && { restrictionId: restricted }) },
      }, tx);
    });
    return this.view(id);
  }

  private async view(id: string) {
    return authView(await this.prisma.markerAuthorization.findUniqueOrThrow({ where: { id }, include: AUTH_INCLUDE }));
  }

  private async requireSubject(id: string) {
    const d = await this.prisma.discipline.findUnique({ where: { id }, select: { id: true, code: true, isActive: true } });
    if (!d) throw new AppError(HttpStatus.BAD_REQUEST, 'SUBJECT_NOT_FOUND', 'Subject not found.', { subjectId: id });
    return d;
  }
}

function authView(a: AuthRow) {
  const { olympiadInterests, ...coach } = a.coach;
  return {
    id: a.id, active: a.revokedAt === null,
    coach: { ...coach, interestedInSubject: (olympiadInterests as string[]).includes(a.discipline.code) },
    subject: a.discipline,
    grantedAt: a.grantedAt, grantedBy: a.grantedBy, grantReason: a.grantReason,
    revokedAt: a.revokedAt, revokedBy: a.revokedBy, revokeReason: a.revokeReason,
  };
}

type Tx = Prisma.TransactionClient;
type Actor = Pick<AuthUser, 'id' | 'role'>;

/** Record that marking was taken away from the coach in the subject (no-op when already). Returns the restriction id. */
export async function restrictMarking(tx: Tx, coachId: string, disciplineId: string, actor: Actor, reason: string): Promise<string> {
  const active = await tx.coachProgrammeRestriction.findFirst({ where: { coachId, disciplineId, capability: 'MARKING', liftedAt: null }, select: { id: true } });
  if (active) return active.id;
  return (await tx.coachProgrammeRestriction.create({ data: { coachId, disciplineId, capability: 'MARKING', reason, createdById: actor.id }, select: { id: true } })).id;
}

/** Lift the coach's MARKING restriction in the subject, if any. */
export async function liftMarkingRestriction(tx: Tx, coachId: string, disciplineId: string, actor: Actor, reason: string): Promise<void> {
  await tx.coachProgrammeRestriction.updateMany({
    where: { coachId, disciplineId, capability: 'MARKING', liftedAt: null },
    data: { liftedAt: new Date(), liftedById: actor.id, liftReason: reason },
  });
}
