import { Module } from '@nestjs/common';
import { MeController, UserAvatarController, UsersController } from './users.controller.js';
import { AccountStatusService } from './account-status.service.js';
import { AvatarService } from './avatar.service.js';
import { UsersService } from './users.service.js';
import { UserProvisioningService } from './user-provisioning.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [AuthModule],
  controllers: [UsersController, MeController, UserAvatarController],
  providers:   [UsersService, UserProvisioningService, AvatarService, AccountStatusService],
  exports:     [UsersService, UserProvisioningService, AccountStatusService],
})
export class UsersModule {}
