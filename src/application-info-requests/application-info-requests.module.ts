import { Global, Module } from '@nestjs/common';
import { ApplicationInfoRequestsController } from './application-info-requests.controller.js';
import { ApplicationInfoRequestsService } from './application-info-requests.service.js';

/** "Request more information" on Teacher and Coach applications (ADR-009). Global: both application modules use it. */
@Global()
@Module({
  controllers: [ApplicationInfoRequestsController],
  providers:   [ApplicationInfoRequestsService],
  exports:     [ApplicationInfoRequestsService],
})
export class ApplicationInfoRequestsModule {}
