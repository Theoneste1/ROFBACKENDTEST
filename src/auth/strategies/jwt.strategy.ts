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
      },
    });

    if (!user || !user.isActive || !user.isApproved || !user.activatedAt) {
      throw new UnauthorizedException('Your session is no longer valid. Please log in again.');
    }
    // Sessions ended (password changed, signed out everywhere, suspended, role
    // changed): tokens issued before then are refused. `iat` has whole-second
    // precision, so tokens issued in that same second still pass.
    if (user.tokensValidAfter && payload.iat !== undefined && payload.iat < Math.floor(user.tokensValidAfter.getTime() / 1000)) {
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
    };
  }
}
