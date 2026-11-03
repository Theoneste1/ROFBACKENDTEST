import { Global, Module } from '@nestjs/common';
import { ActivityController } from './activity.controller.js';
import { ActivityService } from './activity.service.js';
import { RetentionService } from './retention.service.js';

@Global()
@Module({
  controllers: [ActivityController],
  providers:   [ActivityService, RetentionService],
  exports:     [ActivityService, RetentionService],
})
export class ActivityModule {}
