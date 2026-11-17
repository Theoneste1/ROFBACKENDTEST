import { Module } from '@nestjs/common';
import { RegistrationTimelineService } from './registration-timeline.service.js';
import { MeController, UserAvatarController, UsersController } from './users.controller.js';
import { AccountStatusService } from './account-status.service.js';
import { BulkOperationsController } from './bulk/bulk-operations.controller.js';
import { BulkOperationsService } from './bulk/bulk-operations.service.js';
import { BulkOperationsWorker } from './bulk/bulk-operations.worker.js';
import { AvatarService } from './avatar.service.js';
import { UsersService } from './users.service.js';
import { UserProvisioningService } from './user-provisioning.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [AuthModule],
  // BulkOperationsController first: its /admin/users/bulk routes must win over /admin/users/:id.
  controllers: [BulkOperationsController, UsersController, MeController, UserAvatarController],
  providers:   [RegistrationTimelineService, UsersService, UserProvisioningService, AvatarService, AccountStatusService, BulkOperationsService, BulkOperationsWorker],
  exports:     [UsersService, UserProvisioningService, AccountStatusService],
})
export class UsersModule {}
