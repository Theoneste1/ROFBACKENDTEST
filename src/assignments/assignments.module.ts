import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AssignmentsController } from './assignments.controller.js';
import { AssignmentsService } from './assignments.service.js';

@Module({
  imports:     [AuthModule, PrismaModule],
  controllers: [AssignmentsController],
  // AuditService is provided by the @Global() AuditModule.
  providers:   [AssignmentsService],
  exports:     [AssignmentsService],
})
export class AssignmentsModule {}
