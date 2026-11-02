import { Module } from '@nestjs/common';
import { StudyGroupsController } from './study-groups.controller.js';
import { StudyGroupsService } from './study-groups.service.js';
import { GroupMemberGuard } from './guards/group-member.guard.js';

@Module({
  controllers: [StudyGroupsController],
  providers:   [StudyGroupsService, GroupMemberGuard],
  exports:     [StudyGroupsService, GroupMemberGuard],
})
export class StudyGroupsModule {}
