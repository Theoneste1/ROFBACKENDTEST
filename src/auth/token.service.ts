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
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AppError } from '../common/errors/app-error.js';

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
    return this.issueInFamily(userId, randomUUID(), client);
  }

  /** Exchange a refresh token for a new pair. */
  async rotate(rawRefreshToken: string, client: ClientInfo): Promise<{ userId: string; tokens: IssuedTokens }> {
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawRefreshToken) },
    });

    if (!existing) throw invalidRefresh();

    if (existing.revokedAt || existing.rotatedAt) {
      // Replay of a token that was already used → assume theft.
      await this.revokeFamily(existing.familyId);
      throw new AppError(HttpStatus.UNAUTHORIZED, 'REFRESH_TOKEN_REUSED', 'Session invalidated. Please log in again.');
    }
    if (existing.expiresAt < new Date()) throw invalidRefresh();

    const user = await this.prisma.user.findUnique({
      where:  { id: existing.userId },
      select: { isActive: true, isApproved: true },
    });
    if (!user?.isActive || !user.isApproved) {
      await this.revokeFamily(existing.familyId);
      throw invalidRefresh();
    }

    // Conditional update: if two refreshes race, only one wins.
    const { count } = await this.prisma.refreshToken.updateMany({
      where: { id: existing.id, rotatedAt: null, revokedAt: null },
      data:  { rotatedAt: new Date() },
    });
    if (count === 0) {
      await this.revokeFamily(existing.familyId);
      throw new AppError(HttpStatus.UNAUTHORIZED, 'REFRESH_TOKEN_REUSED', 'Session invalidated. Please log in again.');
    }

    return {
      userId: existing.userId,
      tokens: await this.issueInFamily(existing.userId, existing.familyId, client),
    };
  }

  /** Revoke the session that owns this refresh token (logout). */
  async revoke(rawRefreshToken: string): Promise<void> {
    const token = await this.prisma.refreshToken.findUnique({
      where:  { tokenHash: hashToken(rawRefreshToken) },
      select: { familyId: true },
    });
    if (token) await this.revokeFamily(token.familyId);
  }

  /**
   * End every session of a user (password change, suspension, role change,
   * logout-all): refresh tokens are revoked and every access token issued at or
   * before this moment stops working (JwtStrategy compares `iatMs`).
   *
   * Returns only once the clock has moved past the revocation millisecond, so a
   * token issued afterwards (e.g. the next login) is always strictly newer.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.user.update({ where: { id: userId }, data: { tokensValidAfter: now } }),
    ]);
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

  private async revokeFamily(familyId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data:  { revokedAt: new Date() },
    });
  }

  private async issueInFamily(userId: string, familyId: string, client: ClientInfo): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID(), iatMs: Date.now() },
      { expiresIn: this.accessTtlSeconds },
    );

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt    = new Date(Date.now() + this.refreshTtlMs);

    await this.prisma.refreshToken.create({
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
