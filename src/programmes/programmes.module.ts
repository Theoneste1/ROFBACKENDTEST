import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module.js';
import { AdminProgrammesController, ProgrammesController } from './programmes.controller.js';
import { ProgrammesService } from './programmes.service.js';

/** Programmes, heads and members (P1-10). Prisma, access and audit come from global modules. */
@Module({
  imports:     [UsersModule],
  controllers: [ProgrammesController, AdminProgrammesController],
  providers:   [ProgrammesService],
})
export class ProgrammesModule {}
