import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { ActivityService } from './activity.service.js';
import { ActivitySummaryDto, ListActivityDto } from './dto/list-activity.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';

@ApiTags('Admin · Activity')
@Controller('admin/activity')
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  /** Learning activity log, filterable by user, course, type and period. */
  @Get()
  @RequirePermission('activity.view')
  list(@Query() query: ListActivityDto, @CurrentUser() user: AuthUser) {
    return this.activity.list(query, user);
  }

  /** Activity counts per type and number of active users (default: last 30 days). */
  @Get('summary')
  @RequirePermission('activity.view')
  summary(@Query() query: ActivitySummaryDto, @CurrentUser() user: AuthUser) {
    const to   = query.to   ? new Date(query.to)   : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    return this.activity.summary(from, to, user);
  }
}
