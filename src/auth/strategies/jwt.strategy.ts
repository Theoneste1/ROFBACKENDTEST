import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';

import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../../common/auth-user.js';

interface AccessTokenPayload {
  sub: string;
  jti?: string;
  exp?: number;
  /** Issued at (seconds), set by the JWT library. */
  iat?: number;
  /** Issued at (milliseconds), set by TokenService. Absent on tokens issued before it existed. */
  iatMs?: number;
}

/**
 * True when the token was issued at or before the moment the user's sessions
 * were ended. Compared in milliseconds (the precision of tokensValidAfter), so a
 * token issued in the same second as the revocation is refused too. A token
 * without `iatMs` (issued before this check existed) is refused if it was
 * issued in or before the revocation second.
 */
export function issuedBeforeRevocation(payload: Pick<AccessTokenPayload, 'iat' | 'iatMs'>, tokensValidAfter: Date): boolean {
  const revokedAtMs = tokensValidAfter.getTime();
  if (typeof payload.iatMs === 'number' && Number.isFinite(payload.iatMs)) return payload.iatMs <= revokedAtMs;
  if (typeof payload.iat === 'number' && Number.isFinite(payload.iat)) return payload.iat <= Math.floor(revokedAtMs / 1000);
  return true;   // no issue time at all: cannot prove it is newer — refuse
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey:    configService.getOrThrow<string>('JWT_SECRET'),
      algorithms:     ['HS256'],
      ignoreExpiration: false,
    });
  }

  /**
   * Runs on every authenticated request.
   *
   * The user is re-read from the database so that suspension, demotion or a
   * division change takes effect immediately rather than when the token expires.
   */
  async validate(payload: AccessTokenPayload): Promise<AuthUser> {
    if (payload.jti) {
      const revoked = await this.prisma.tokenBlacklist.findUnique({
        where:  { jti: payload.jti },
        select: { id: true },
      });
      if (revoked) {
        throw new UnauthorizedException('Token has been invalidated. Please log in again.');
      }
    }

    const user = await this.prisma.user.findUnique({
      where:  { id: payload.sub },
      select: {
        id: true, username: true, role: true, isActive: true, isApproved: true, activatedAt: true,
        divisionId: true, gradeLevel: true, tokensValidAfter: true,
        // Active individual overrides (P1-09): read fresh on every request, so a
        // revocation applies on the next request and nothing is cached.
        permissionOverrides: {
          where:  { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          select: { id: true, permission: true, effect: true, courseId: true, divisionId: true, expiresAt: true },
        },
      },
    });

    if (!user || !user.isActive || !user.isApproved || !user.activatedAt) {
      throw new UnauthorizedException('Your session is no longer valid. Please log in again.');
    }
    // Sessions ended (password changed, signed out everywhere, suspended, role
    // changed): every token issued at or before that moment is refused —
    // including one issued in the same second (millisecond comparison).
    if (user.tokensValidAfter && issuedBeforeRevocation(payload, user.tokensValidAfter)) {
      throw new UnauthorizedException('Your session is no longer valid. Please log in again.');
    }

    return {
      id:         user.id,
      username:   user.username,
      role:       user.role,
      divisionId: user.divisionId,
      gradeLevel: user.gradeLevel,
      jti:        payload.jti,
      exp:        payload.exp,
      overrides:  user.permissionOverrides,
    };
  }
}
