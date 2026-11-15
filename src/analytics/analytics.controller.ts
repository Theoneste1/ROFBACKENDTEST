import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

import { AnalyticsService } from './analytics.service.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

class CourseAnalyticsQueryDto {
  @IsUUID()
  divisionId: string;
}

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  /**
   * Course analytics for one division: enrollment funnel, per-assignment
   * submission rates and score distribution, review turnaround, resource
   * engagement. Mentors: only scopes they teach.
   */
  @Get('courses/:courseId')
  @RequirePermission('analytics.course')
  course(
    @Param('courseId', ParseUUIDPipe) courseId: string,
    @Query() query: CourseAnalyticsQueryDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.analytics.courseAnalytics(courseId, query.divisionId, user);
  }
}
