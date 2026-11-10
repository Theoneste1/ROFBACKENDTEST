import { Module } from '@nestjs/common';

import { AdminProgrammesController, ProgrammesController } from './programmes.controller.js';
import { ProgrammesService } from './programmes.service.js';

/** Programmes, heads and members (P1-10). Prisma, access and audit come from global modules. */
@Module({
  controllers: [ProgrammesController, AdminProgrammesController],
  providers:   [ProgrammesService],
})
export class ProgrammesModule {}
