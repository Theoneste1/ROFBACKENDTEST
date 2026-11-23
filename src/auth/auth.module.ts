import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenService } from './token.service.js';
import { ActivationService } from './activation.service.js';
import { TokenCleanupService } from './token-cleanup.service.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { LoginLimiter } from './login-limiter.js';
import { ViewAsAdminController, ViewAsAuthController } from './view-as/view-as.controller.js';
import { ViewAsService } from './view-as/view-as.service.js';

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
  controllers: [AuthController, ViewAsAdminController, ViewAsAuthController],
  // AuditService, SettingsService, DivisionsService and NotificationsService
  // come from @Global() modules.
  providers: [
    AuthService, TokenService, ActivationService, JwtStrategy, TokenCleanupService, ViewAsService,
    {
      // Sign-in protection (owner approval 2026-11-18). The username windows follow the test-only throttle switch.
      provide: LoginLimiter, inject: [ConfigService],
      useFactory: (config: ConfigService) => new LoginLimiter(
        config.getOrThrow<string>('JWT_SECRET'),
        () => config.get('NODE_ENV') === 'test' && process.env.THROTTLE_DISABLED === 'true',
        Date.now,
        // The known-address exemption only where client addresses are verified (staging evidence 2026-11-18).
        () => process.env.SIGNIN_TRUSTED_CLIENT_ADDRESS === 'true',
      ),
    },
  ],
  exports:   [AuthService, TokenService, ActivationService],
})
export class AuthModule {}
