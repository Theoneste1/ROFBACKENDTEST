import { Module } from '@nestjs/common';

import { CoachAccessController, CoachStudentsController } from './coach-access.controller.js';
import { CoachAccessService } from './coach-access.service.js';

@Module({
  controllers: [CoachStudentsController, CoachAccessController],
  providers: [CoachAccessService],
})
export class CoachAccessModule {}
