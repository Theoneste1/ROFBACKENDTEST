import { Module } from '@nestjs/common';
import { SchoolsController } from './schools.controller.js';
import { SchoolsService } from './schools.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [SchoolsController],
  providers:   [SchoolsService],
  exports:     [SchoolsService],
})
export class SchoolsModule {}
