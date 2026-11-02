import { Module } from '@nestjs/common';
import { MeController, UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [AuthModule],
  controllers: [UsersController, MeController],
  providers:   [UsersService],
  exports:     [UsersService],
})
export class UsersModule {}
