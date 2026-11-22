import { Module } from '@nestjs/common';

import { TableLayoutsController } from './table-layouts.controller.js';
import { TableLayoutsService } from './table-layouts.service.js';

@Module({
  controllers: [TableLayoutsController],
  providers: [TableLayoutsService],
})
export class TableLayoutsModule {}
