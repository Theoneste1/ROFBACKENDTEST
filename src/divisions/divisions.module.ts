import { Global, Module } from '@nestjs/common';
import { DivisionsController } from './divisions.controller.js';
import { DivisionsService } from './divisions.service.js';

@Global()
@Module({
  controllers: [DivisionsController],
  providers:   [DivisionsService],
  exports:     [DivisionsService],
})
export class DivisionsModule {}
