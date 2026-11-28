/**
 * TokenService — access-token signing and refresh-token rotation.
 *
 * Access tokens: short-lived JWTs (default 15 min) carrying only `sub`, `jti` and
 * `iatMs` (issue time in milliseconds, checked against `User.tokensValidAfter`).
 *
 * Refresh tokens: opaque random strings, stored as SHA-256 hashes.
 *   - Every refresh exchanges the presented token for a new one (rotation).
 *   - All tokens from one login share a `familyId`.
 *   - Presenting an already-rotated or revoked token means it was stolen or
 *     replayed: the whole family is revoked and the user must log in again.
 *
 * Session changes of one user are serialised by a transaction-scoped advisory
 * lock (namespace SESSION_LOCK_NAMESPACE, key = the user id): rotation, logout
 * (revoke a family) and "end every session" (revokeAllForUser). Without it a
 * refresh racing a logout could create its new token after the revocation had
 * already run, and that token would survive the logout (PostgreSQL's UPDATE
 * only sees rows committed before the statement started).
 *
 * LOCK ORDER (deadlock rule): the session lock comes BEFORE any lock on the
 * user's "User" row. Rotation holds the session lock while it inserts the new
 * RefreshToken, whose foreign key takes a KEY SHARE lock on that User row; a
 * transaction that first locks the row FOR UPDATE and then asks for the session
 * lock (e.g. an administrator's role or password change) would deadlock with it.
 * Such a transaction calls `lockSessions` first (users.service.ts `update`).
 * Plain UPDATEs of non-key User columns (FOR NO KEY UPDATE) do not conflict with
 * KEY SHARE and need nothing.
 *
 * INACTIVITY (owner 2026-11-28: signed out after 60 minutes without activity). Each token row carries the session's
 * last USER activity (`lastActivityAt`): set at sign-in, moved forward only by `recordActivity` (POST /auth/activity,
 * which the browser sends for clicks, typing, scrolling and touch - never for background requests), and copied
 * UNCHANGED by a refresh, so background refreshes never keep a session alive. The server refuses (and revokes):
 *   - a refresh more than SESSION_IDLE_LIMIT_MS after the last activity (401 SESSION_IDLE_EXPIRED), and
 *   - an activity report for a session already past that limit (it cannot be revived).
 * An access token never outlives the session's inactivity deadline: its expiry is min(15 min, deadline - now), so no
 * request is accepted after the deadline even without the browser's help. The browser signs out at exactly 60 minutes;
 * the server's limit adds SESSION_IDLE_GRACE_MS for activity reports still in transit (the browser reports at most
 * once a minute).
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AppError } from '../common/errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';

export interface IssuedTokens {
  access_token:  string;
  token_type:    'Bearer';
  expires_in:    number;
  refresh_token: string;
  refresh_expires_at: Date;
}

export interface ClientInfo {
  userAgent?: string;
  ip?:        string;
}

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/** A session ends after this long without user activity (owner 2026-11-28). */
export const SESSION_IDLE_MINUTES = 60;
/** Allowance for activity reports in transit (the browser sends at most one a minute) and clock differences. */
export const SESSION_IDLE_GRACE_MS = 2 * 60_000;
/** The server's limit: no refresh, activity report or access token beyond it. */
export const SESSION_IDLE_LIMIT_MS = SESSION_IDLE_MINUTES * 60_000 + SESSION_IDLE_GRACE_MS;
/** A rotated token still identifies its session for an activity report this long after it was replaced (tabs racing a refresh). */
const ROTATED_ACTIVITY_GRACE_MS = 60_000;

/** When the session's inactivity ends: its last activity (or, for a token issued before the column, its issue time) + the limit. */
export function idleDeadline(token: { lastActivityAt: Date | null; createdAt: Date }): Date {
  return new Date((token.lastActivityAt ?? token.createdAt).getTime() + SESSION_IDLE_LIMIT_MS);
}

/** Advisory-lock namespace for one user's sessions (other namespaces: 4209–4215). */
export const SESSION_LOCK_NAMESPACE = 4216;

type Db = Prisma.TransactionClient;

/** Serialise session changes of one user until the end of the current transaction. */
async function lockUserSessions(tx: Db, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SESSION_LOCK_NAMESPACE}::int, hashtext(${userId}))::text`;
}

async function revokeFamily(tx: Db, familyId: string): Promise<void> {
  await tx.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** The claims of a valid access token (signature and expiry checked), or null. */
export interface AccessClaims {
  sub: string;
  jti?: string;
  exp?: number;
}

type RotateResult =
  | { kind: 'ok'; userId: string; tokens: IssuedTokens }
  | { kind: 'reused' }
  | { kind: 'idle' }
  | { kind: 'invalid' };

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt:    JwtService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  get accessTtlSeconds(): number {
    return Number(this.config.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
  }

  get refreshTtlMs(): number {
    return Number(this.config.get('REFRESH_TOKEN_TTL_DAYS') ?? 30) * 24 * 60 * 60 * 1000;
  }

  /** Start a new session (login). */
  async issue(userId: string, client: ClientInfo): Promise<IssuedTokens> {
    return this.issueInFamily(this.prisma, userId, randomUUID(), client, new Date());
  }

  /**
   * Exchange a refresh token for a new pair. The checks and the new token are
   * written under the user's session lock, in one transaction: a logout or
   * "end every session" either runs first (this token is then revoked → reuse)
   * or after (it then revokes the new token too).
   */
  async rotate(rawRefreshToken: string, client: ClientInfo): Promise<{ userId: string; tokens: IssuedTokens }> {
    const found = await this.prisma.refreshToken.findUnique({
      where:  { tokenHash: hashToken(rawRefreshToken) },
      select: { id: true, userId: true },
    });
    if (!found) throw invalidRefresh();

    // Revocations are written inside the transaction and committed with it; the
    // error is thrown afterwards (throwing inside would roll them back).
    const result = await this.prisma.$transaction(async (tx): Promise<RotateResult> => {
      await lockUserSessions(tx, found.userId);
      const existing = await tx.refreshToken.findUnique({ where: { id: found.id } });
      if (!existing) return { kind: 'invalid' };

      if (existing.revokedAt || existing.rotatedAt) {
        // Replay of a token that was already used or revoked → assume theft.
        await revokeFamily(tx, existing.familyId);
        return { kind: 'reused' };
      }
      if (existing.expiresAt < new Date()) return { kind: 'invalid' };
      // 60 minutes without user activity: the session ends here, whatever refreshes happened meanwhile.
      if (idleDeadline(existing) <= new Date()) {
        await revokeFamily(tx, existing.familyId);
        return { kind: 'idle' };
      }

      const user = await tx.user.findUnique({
        where:  { id: existing.userId },
        select: { isActive: true, isApproved: true },
      });
      if (!user?.isActive || !user.isApproved) {
        await revokeFamily(tx, existing.familyId);
        return { kind: 'invalid' };
      }

      // Still conditional, as a second line of defence behind the lock.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: existing.id, rotatedAt: null, revokedAt: null },
        data:  { rotatedAt: new Date() },
      });
      if (count === 0) {
        await revokeFamily(tx, existing.familyId);
        return { kind: 'reused' };
      }

      // The new token carries the SAME last activity: a refresh is not activity.
      const lastActivity = existing.lastActivityAt ?? existing.createdAt;
      return { kind: 'ok', userId: existing.userId, tokens: await this.issueInFamily(tx, existing.userId, existing.familyId, client, lastActivity) };
    });

    if (result.kind === 'reused') {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'REFRESH_TOKEN_REUSED', 'Session invalidated. Please log in again.');
    }
    if (result.kind === 'idle') throw idleExpired();
    if (result.kind === 'invalid') throw invalidRefresh();
    return { userId: result.userId, tokens: result.tokens };
  }

  /**
   * The user did something (click, typing, scrolling, touch - reported by the browser, at most once a minute): the
   * session of this refresh token is active now. Only the session's current token is moved forward (the presented
   * token may be the one it was just rotated from, for a tab that has not seen the new cookie yet), only for its own
   * user, and never once the session is past its inactivity limit - an expired session cannot be revived. Returns the
   * new inactivity deadline, or throws 401 SESSION_IDLE_EXPIRED (the session is revoked) / INVALID_REFRESH_TOKEN.
   */
  async recordActivity(rawRefreshToken: string, userId: string): Promise<{ idleDeadline: Date }> {
    const found = await this.prisma.refreshToken.findUnique({
      where:  { tokenHash: hashToken(rawRefreshToken) },
      select: { userId: true },
    });
    if (!found || found.userId !== userId) throw invalidRefresh();
    const outcome = await this.prisma.$transaction(async (tx): Promise<{ kind: 'ok'; deadline: Date } | { kind: 'idle' } | { kind: 'invalid' }> => {
      await lockUserSessions(tx, userId);
      const now = new Date();
      const presented = await tx.refreshToken.findUnique({ where: { tokenHash: hashToken(rawRefreshToken) } });
      if (!presented || presented.revokedAt || presented.expiresAt <= now) return { kind: 'invalid' };
      if (presented.rotatedAt && now.getTime() - presented.rotatedAt.getTime() > ROTATED_ACTIVITY_GRACE_MS) return { kind: 'invalid' };
      const current = await tx.refreshToken.findFirst({
        where:  { familyId: presented.familyId, revokedAt: null, rotatedAt: null, expiresAt: { gt: now } },
        select: { id: true, lastActivityAt: true, createdAt: true },
      });
      if (!current) return { kind: 'invalid' };
      if (idleDeadline(current) <= now) {
        await revokeFamily(tx, presented.familyId);
        return { kind: 'idle' };
      }
      await tx.refreshToken.update({ where: { id: current.id }, data: { lastActivityAt: now } });
      return { kind: 'ok', deadline: idleDeadline({ lastActivityAt: now, createdAt: now }) };
    });
    if (outcome.kind === 'idle') throw idleExpired();
    if (outcome.kind === 'invalid') throw invalidRefresh();
    return { idleDeadline: outcome.deadline };
  }

  /**
   * Revoke the session (token family) that owns this refresh token (logout).
   * Works for any state of the token — current, already rotated, revoked or
   * expired — so a stale cookie still ends its session. Returns the owner, or
   * null when the token is unknown.
   */
  async revoke(rawRefreshToken: string): Promise<{ userId: string } | null> {
    const token = await this.prisma.refreshToken.findUnique({
      where:  { tokenHash: hashToken(rawRefreshToken) },
      select: { userId: true, familyId: true },
    });
    if (!token) return null;
    await this.prisma.$transaction(async (tx) => {
      await lockUserSessions(tx, token.userId);
      await revokeFamily(tx, token.familyId);
    });
    return { userId: token.userId };
  }

  /**
   * Take the user's session lock inside the caller's transaction (held until it
   * ends; re-entrant, so a later revokeAllForUser in the same transaction does
   * not block). Call it before locking the user's row FOR UPDATE — see LOCK ORDER.
   */
  async lockSessions(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await lockUserSessions(tx, userId);
  }

  /**
   * Verify an access token (signature, algorithm, expiry) without the request
   * guard: used by logout, which is public so that it also works once the
   * access token has expired. Null for any invalid or expired token.
   */
  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    try {
      const claims = await this.jwt.verifyAsync<AccessClaims>(token, { algorithms: ['HS256'] });
      return typeof claims?.sub === 'string' ? claims : null;
    } catch {
      return null;
    }
  }

  /**
   * End every session of a user (password change, suspension, role change,
   * logout-all): refresh tokens are revoked and every access token issued at or
   * before this moment stops working (JwtStrategy compares `iatMs`).
   *
   * With `tx`, the revocation is written inside the caller's transaction, so it
   * commits together with the change that requires it (e.g. a role change): no
   * request can see the new role while an old token is still valid.
   *
   * Returns only once the clock has moved past the revocation millisecond, so a
   * token issued afterwards (e.g. the next login) is always strictly newer.
   *
   * The revocation time is taken only after the user's session lock is held: a
   * refresh that was in progress has then committed, and the access token it
   * issued is older than `tokensValidAfter` (so it is refused too).
   */
  async revokeAllForUser(userId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const run = async (db: Db) => {
      await lockUserSessions(db, userId);
      const now = new Date();
      await db.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await db.user.update({ where: { id: userId }, data: { tokensValidAfter: now } });
      return now;
    };
    const now = tx ? await run(tx) : await this.prisma.$transaction(run);
    while (Date.now() <= now.getTime()) await new Promise((r) => setTimeout(r, 1));
  }

  /** Blacklist an access token until it expires. */
  async blacklistAccessToken(jti: string, exp?: number): Promise<void> {
    const expiresAt = exp ? new Date(exp * 1000) : new Date(Date.now() + this.accessTtlSeconds * 1000);
    await this.prisma.tokenBlacklist.upsert({
      where:  { jti },
      create: { jti, expiresAt },
      update: {},
    });
  }

  private async issueInFamily(db: Db | PrismaService, userId: string, familyId: string, client: ClientInfo, lastActivity: Date): Promise<IssuedTokens> {
    // Never valid beyond the session's inactivity deadline (at least one second, so it is a well-formed token).
    const untilIdle = Math.floor((lastActivity.getTime() + SESSION_IDLE_LIMIT_MS - Date.now()) / 1000);
    const expiresIn = Math.max(1, Math.min(this.accessTtlSeconds, untilIdle));
    const accessToken = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID(), iatMs: Date.now() },
      { expiresIn },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt    = new Date(Date.now() + this.refreshTtlMs);

    await db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt,
        lastActivityAt: lastActivity,
        userAgent: client.userAgent?.slice(0, 300),
        ip:        client.ip?.slice(0, 64),
      },
    });

    return {
      access_token:       accessToken,
      token_type:         'Bearer',
      expires_in:         expiresIn,
      refresh_token:      refreshToken,
      refresh_expires_at: expiresAt,
    };
  }
}

function idleExpired() {
  return new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_IDLE_EXPIRED',
    `You were signed out after ${SESSION_IDLE_MINUTES} minutes without activity. Please sign in again.`);
}

function invalidRefresh() {
  return new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token.');
}
