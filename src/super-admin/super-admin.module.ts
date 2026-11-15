import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { SuperAdminOperationsService } from './super-admin-operations.service.js';

/** Operator commands for Super Admin bootstrap and break-glass (CLI only — no controller). */
@Module({
  imports:   [AuthModule],
  providers: [SuperAdminOperationsService],
  exports:   [SuperAdminOperationsService],
})
export class SuperAdminModule {}
