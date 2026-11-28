/**
 * "View as" — an administrator sees the platform exactly as a lower-ranked user does, READ ONLY
 * (owner decision 2026-11-23; rules: view-as.rules.ts).
 *
 *   1. POST /admin/users/:id/view-as (users.impersonate) checks the rules and returns a single-use TICKET (random,
 *      stored hashed, 60 seconds) — never a token in a URL. Audit VIEW_AS_STARTED.
 *   2. POST /auth/view-as/exchange { ticket } returns a VIEWING access token: sub = the viewed user, claim
 *      va = { actorId, sessionId }, 30 minutes, NO refresh token and NO cookie.
 *   3. Every request with it (JwtStrategy → resolve) re-checks that the session is open and not expired, that the viewer
 *      is still active, has not signed out everywhere, still holds users.impersonate (overrides included) and may still
 *      view this user; otherwise the session is ended and 401 VIEW_AS_ENDED. The request's user is the VIEWED user.
 *   4. Every non-GET request is refused (ViewAsReadOnlyGuard), and the database refuses writes
 *      (src/prisma/read-only-while-viewing.ts). POST /auth/view-as/end closes the session (audit VIEW_AS_ENDED).
 * The viewed user's own sessions are never touched.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomUUID } from 'crypto';

import { AuditService } from '../../audit/audit.service.js';
import type { AuthUser, ViewAsInfo } from '../../common/auth-user.js';
import { allowWritesWhileViewing, markViewing } from '../../common/request-context.js';
import { isHiddenAccount } from '../../common/access/super-admin-privacy.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { activeOverridesSelect } from '../active-overrides.js';
import { PermissionService } from '../permission.service.js';
import { hashToken } from '../token.service.js';
import { viewAsEnded, viewAsNotAllowed } from './view-as.errors.js';
import { viewAsRefusal } from './view-as.rules.js';

export interface ViewAsClaim {
  actorId:   string;
  sessionId: string;
}

export const VIEW_AS_TICKET_TTL_MS = 60_000;
export const VIEW_AS_TOKEN_TTL_SECONDS = 30 * 60;

export type ViewAsEndReason =
  'ENDED_BY_ACTOR' | 'EXPIRED' | 'PERMISSION_REMOVED' | 'ACTOR_INACTIVE' | 'ACTOR_SIGNED_OUT' | 'TARGET_NOT_VIEWABLE';

const PERSON = { id: true, role: true, username: true, firstName: true, lastName: true } as const;

type Person = { id: string; role: string; username: string; firstName: string; lastName: string };
type Actor = Person & {
  isActive: boolean; isApproved: boolean; activatedAt: Date | null; tokensValidAfter: Date | null;
  permissionOverrides: AuthUser['overrides'];
};

const nameOf = (p: Person): string => `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim() || p.username;
const personOf = (p: Person) => ({ id: p.id, name: nameOf(p), role: p.role });

function isClaim(value: unknown): value is ViewAsClaim {
  return typeof value === 'object' && value !== null
    && typeof (value as ViewAsClaim).actorId === 'string' && typeof (value as ViewAsClaim).sessionId === 'string';
}

@Injectable()
export class ViewAsService {
  constructor(
    private readonly prisma:      PrismaService,
    private readonly jwt:         JwtService,
    private readonly permissions: PermissionService,
    private readonly audit:       AuditService,
  ) {}

  /** Start: check the rules, store a hashed single-use ticket, audit VIEW_AS_STARTED. */
  async start(targetId: string, actor: AuthUser, reason: string | undefined, requestId: string | undefined) {
    if (actor.viewAs) throw viewAsNotAllowed('You cannot start viewing as someone while already viewing as someone.');
    const target = await this.prisma.user.findUnique({ where: { id: targetId }, select: PERSON });
    // A Super Administrator does not exist for anyone else (Super Administrator privacy): the same 404.
    if (!target || isHiddenAccount(actor, target)) throw new NotFoundException('User not found.');
    const refusal = viewAsRefusal(actor, target);
    if (refusal) throw viewAsNotAllowed(refusal);

    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + VIEW_AS_TICKET_TTL_MS);
    const why = reason ? reason : null;
    await this.prisma.$transaction(async (tx) => {
      const session = await tx.viewAsSession.create({
        data: { actorId: actor.id, targetId: target.id, reason: why, ticketHash: hashToken(ticket), ticketExpiresAt: expiresAt, requestId: requestId ?? null },
        select: { id: true },
      });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'VIEW_AS_STARTED', entity: 'ViewAsSession', entityId: session.id,
        metadata: { targetUserId: target.id, targetRole: target.role, reason: why, requestId: requestId ?? null },
      }, tx);
    });
    return { ticket, expiresAt };
  }

  /** Exchange a ticket (once, within 60 seconds) for a 30-minute viewing token. */
  async exchange(ticket: string) {
    const ticketHash = hashToken(ticket);
    const found = await this.prisma.viewAsSession.findUnique({ where: { ticketHash }, select: { id: true } });
    if (!found) throw ticketInvalid();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + VIEW_AS_TOKEN_TTL_SECONDS * 1000);
    // Single use: only the first exchange of an unexpired ticket changes the row; the hash is cleared with it.
    const { count } = await this.prisma.viewAsSession.updateMany({
      where: { id: found.id, ticketHash, startedAt: null, endedAt: null, ticketExpiresAt: { gt: now } },
      data:  { startedAt: now, expiresAt, ticketHash: null },
    });
    if (count === 0) throw ticketInvalid();

    const session = await this.load(found.id);
    const why = this.refusalReason(session!.actor, session!.target, now);
    if (why) {
      await this.close(found.id, why, session!.actor, session!.target);
      throw viewAsNotAllowed('You can no longer view the platform as this user.');
    }
    const accessToken = await this.jwt.signAsync(
      { sub: session!.target.id, jti: randomUUID(), iatMs: now.getTime(), va: { actorId: session!.actor.id, sessionId: found.id } },
      { expiresIn: VIEW_AS_TOKEN_TTL_SECONDS },
    );
    return {
      accessToken, tokenType: 'Bearer' as const, expiresAt,
      viewAs: { sessionId: found.id, actor: personOf(session!.actor), target: personOf(session!.target), expiresAt },
    };
  }

  /**
   * JwtStrategy, for a token with a `va` claim: re-check everything, then return the VIEWED user (with `viewAs`).
   * 401 VIEW_AS_ENDED otherwise (an open session whose checks fail is ended first).
   */
  async resolve(sub: string, claim: unknown, token: { jti?: string; exp?: number }): Promise<AuthUser> {
    if (!isClaim(claim)) throw viewAsEnded();
    const now = new Date();
    const s = await this.load(claim.sessionId);
    if (!s || s.actorId !== claim.actorId || s.targetId !== sub || !s.startedAt || s.endedAt || !s.expiresAt || s.expiresAt <= now) {
      throw viewAsEnded();
    }
    const why = this.refusalReason(s.actor, s.target, s.startedAt);
    if (why) {
      await this.close(s.id, why, s.actor, s.target);
      throw viewAsEnded();
    }
    const t = s.target;
    const viewAs: ViewAsInfo = { sessionId: s.id, actor: personOf(s.actor), target: personOf(t), expiresAt: s.expiresAt };
    markViewing({ sessionId: s.id, actorId: s.actor.id, actorRole: s.actor.role, targetId: t.id });
    return {
      id: t.id, username: t.username, role: t.role, divisionId: t.divisionId, gradeLevel: t.gradeLevel,
      jti: token.jti, exp: token.exp, overrides: t.permissionOverrides,
      ...(t.role === 'STUDENT' && t.dateOfBirth === null && { dateOfBirthRequired: true as const }),
      viewAs,
    };
  }

  /**
   * End the session of a viewing token (POST /auth/view-as/end, or sign-out of the viewing tab). The token's
   * signature is checked, its expiry is not (ending an expired session is allowed). Returns false when the token is
   * not a valid viewing token. Idempotent.
   */
  async endFromToken(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    let claims: { sub?: unknown; va?: unknown };
    try {
      claims = await this.jwt.verifyAsync(token, { algorithms: ['HS256'], ignoreExpiration: true });
    } catch {
      return false;
    }
    if (!isClaim(claims.va) || typeof claims.sub !== 'string') return false;
    const s = await this.load(claims.va.sessionId);
    if (!s || s.actorId !== claims.va.actorId || s.targetId !== claims.sub) return false;
    if (!s.endedAt) {
      const expired = !s.expiresAt || s.expiresAt <= new Date();
      await this.close(s.id, expired ? 'EXPIRED' : 'ENDED_BY_ACTOR', s.actor, s.target);
    }
    return true;
  }

  private load(id: string) {
    return this.prisma.viewAsSession.findUnique({
      where: { id },
      select: {
        id: true, actorId: true, targetId: true, startedAt: true, expiresAt: true, endedAt: true,
        actor: {
          select: {
            ...PERSON, isActive: true, isApproved: true, activatedAt: true, tokensValidAfter: true,
            permissionOverrides: activeOverridesSelect(),
          },
        },
        target: {
          select: {
            ...PERSON, divisionId: true, gradeLevel: true, dateOfBirth: true,
            permissionOverrides: activeOverridesSelect(),
          },
        },
      },
    });
  }

  /** Why the session can no longer go on (checked on every request), or null. */
  private refusalReason(actor: Actor, target: Person, startedAt: Date): ViewAsEndReason | null {
    if (!actor.isActive || !actor.isApproved || !actor.activatedAt) return 'ACTOR_INACTIVE';
    // The viewer signed out everywhere, changed their password, or was suspended / had their role changed.
    if (actor.tokensValidAfter && actor.tokensValidAfter.getTime() >= startedAt.getTime()) return 'ACTOR_SIGNED_OUT';
    const actorUser: AuthUser = {
      id: actor.id, username: actor.username, role: actor.role as AuthUser['role'], divisionId: null, gradeLevel: null,
      overrides: actor.permissionOverrides,
    };
    if (!this.permissions.has(actorUser, 'users.impersonate')) return 'PERMISSION_REMOVED';
    if (viewAsRefusal(actor, target) !== null) return 'TARGET_NOT_VIEWABLE';
    return null;
  }

  /** End an open session (once) and record VIEW_AS_ENDED as the viewer. */
  private async close(id: string, reason: ViewAsEndReason, actor: Person, target: Person): Promise<void> {
    await allowWritesWhileViewing(async () => {
      const { count } = await this.prisma.viewAsSession.updateMany({
        where: { id, endedAt: null }, data: { endedAt: new Date(), endedReason: reason },
      });
      if (count === 0) return;
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action: 'VIEW_AS_ENDED', entity: 'ViewAsSession', entityId: id,
        metadata: { targetUserId: target.id, targetRole: target.role, reason },
      });
    });
  }
}

function ticketInvalid() {
  return viewAsNotAllowed('This viewing link is not valid any more (it works once, for one minute). Start again from the user\'s page.');
}
