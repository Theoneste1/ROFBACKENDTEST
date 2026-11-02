import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { TokenCleanupService } from './token-cleanup.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      inject:  [ConfigService],
      useFactory: (config: ConfigService) => ({
        // getOrThrow: never sign tokens with an undefined secret.
        secret:      config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { algorithm: 'HS256', expiresIn: Number(config.get('JWT_ACCESS_TTL_SECONDS') ?? 900) },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController],
  // AuditService, SettingsService, DivisionsService and NotificationsService
  // come from @Global() modules.
  providers: [AuthService, TokenService, JwtStrategy, TokenCleanupService],
  exports:   [AuthService, TokenService],
})
export class AuthModule {}
