import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';

import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { TokenCleanupService } from './token-cleanup.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

@Module({
  imports: [
    PrismaModule,
    ConfigModule,
    ScheduleModule.forRoot(),

    PassportModule.register({ defaultStrategy: 'jwt' }),

    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject:  [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret:      configService.get<string>('JWT_SECRET'),
        signOptions: { expiresIn: '1d' },
      }),
    }),
  ],
  controllers: [AuthController],
  // AuditService is provided by the @Global() AuditModule — no re-provision needed.
  providers: [AuthService, JwtStrategy, TokenCleanupService],
  exports:   [AuthService, PassportModule, JwtModule],
})
export class AuthModule {}
