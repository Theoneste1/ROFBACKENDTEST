import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey:    configService.getOrThrow<string>('JWT_SECRET'),
      // Pass the raw request so we can inspect the full payload
      passReqToCallback: false,
    });
  }

  async validate(payload: any) {
    // If this token's jti has been blacklisted (i.e. logged out), reject it.
    if (payload.jti) {
      const blacklisted = await this.authService.isTokenBlacklisted(payload.jti);
      if (blacklisted) {
        throw new UnauthorizedException('Token has been invalidated. Please log in again.');
      }
    }

    return {
      id:       payload.sub,
      username: payload.username,
      role:     payload.role,
      jti:      payload.jti,
      exp:      payload.exp,
    };
  }
}
