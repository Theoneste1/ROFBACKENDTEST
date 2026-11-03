import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ActivityService } from './activity.service.js';
import { ActivitySummaryDto, ListActivityDto } from './dto/list-activity.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';

@ApiTags('Admin · Activity')
@Controller('admin/activity')
@Roles('ADMIN')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  /** Learning activity log, filterable by user, course, type and period. */
  @Get()
  list(@Query() query: ListActivityDto) {
    return this.activity.list(query);
  }

  /** Activity counts per type and number of active users (default: last 30 days). */
  @Get('summary')
  summary(@Query() query: ActivitySummaryDto) {
    const to   = query.to   ? new Date(query.to)   : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    return this.activity.summary(from, to);
  }
}
