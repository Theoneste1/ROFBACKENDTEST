import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { CustomReportsController } from './custom-reports.controller.js';
import { CustomReportsService } from './custom-reports.service.js';

@Module({
  imports: [AuthModule],
  controllers: [CustomReportsController],
  providers: [CustomReportsService],
})
export class CustomReportsModule {}
