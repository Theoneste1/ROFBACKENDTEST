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
    return this.issueInFamily(this.prisma, userId, randomUUID(), client);
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

      return { kind: 'ok', userId: existing.userId, tokens: await this.issueInFamily(tx, existing.userId, existing.familyId, client) };
    });

    if (result.kind === 'reused') {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'REFRESH_TOKEN_REUSED', 'Session invalidated. Please log in again.');
    }
    if (result.kind === 'invalid') throw invalidRefresh();
    return { userId: result.userId, tokens: result.tokens };
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

  private async issueInFamily(db: Db | PrismaService, userId: string, familyId: string, client: ClientInfo): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID(), iatMs: Date.now() },
      { expiresIn: this.accessTtlSeconds },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt    = new Date(Date.now() + this.refreshTtlMs);

    await db.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt,
        userAgent: client.userAgent?.slice(0, 300),
        ip:        client.ip?.slice(0, 64),
      },
    });

    return {
      access_token:       accessToken,
      token_type:         'Bearer',
      expires_in:         this.accessTtlSeconds,
      refresh_token:      refreshToken,
      refresh_expires_at: expiresAt,
    };
  }
}

function invalidRefresh() {
  return new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_REFRESH_TOKEN', 'Invalid or expired refresh token.');
}
