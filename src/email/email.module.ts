import { Module } from '@nestjs/common';
import { EmailController } from './email.controller.js';
import { EmailService } from './email.service.js';
import { SmtpService } from './smtp.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [EmailController],
  // AuditService is provided by the @Global() AuditModule.
  providers:   [EmailService, SmtpService],
  exports:     [EmailService, SmtpService],
})
export class EmailModule {}
