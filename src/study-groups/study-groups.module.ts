import { Module } from '@nestjs/common';
import { StudyGroupsController } from './study-groups.controller.js';
import { StudyGroupsService } from './study-groups.service.js';
import { GroupMemberGuard } from './guards/group-member.guard.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuthModule } from '../auth/auth.module.js';

@Module({
  imports:     [PrismaModule, AuthModule],
  controllers: [StudyGroupsController],
  providers:   [StudyGroupsService, GroupMemberGuard],
  exports:     [StudyGroupsService, GroupMemberGuard],
})
export class StudyGroupsModule {}
