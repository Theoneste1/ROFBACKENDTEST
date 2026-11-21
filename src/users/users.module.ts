import { Module } from '@nestjs/common';
import { RegistrationTimelineService } from './registration-timeline.service.js';
import { MeController, UserAvatarController, UsersController } from './users.controller.js';
import { AccountStatusService } from './account-status.service.js';
import { BulkOperationsController } from './bulk/bulk-operations.controller.js';
import { UserBulkHandler } from './bulk/user-bulk.handler.js';
import { AvatarService } from './avatar.service.js';
import { UsersService } from './users.service.js';
import { UserProvisioningService } from './user-provisioning.service.js';
import { AuthModule } from '../auth/auth.module.js';
import { OlympiadLevelController } from './olympiad-level.controller.js';
import { OlympiadLevelService } from './olympiad-level.service.js';

@Module({
  imports:     [AuthModule],
  // BulkOperationsController first: its /admin/users/bulk routes must win over /admin/users/:id.
  controllers: [BulkOperationsController, UsersController, MeController, UserAvatarController, OlympiadLevelController],
  providers:   [RegistrationTimelineService, UsersService, UserProvisioningService, AvatarService, AccountStatusService, UserBulkHandler, OlympiadLevelService],
  exports:     [UsersService, UserProvisioningService, AccountStatusService, OlympiadLevelService],
})
export class UsersModule {}
