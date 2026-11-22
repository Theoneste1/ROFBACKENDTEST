import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import type { AuthUser } from '../common/auth-user.js';
import { Authenticated } from '../common/decorators/authenticated.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { StudentOverviewService } from './student-overview.service.js';

/** The Student Profile Overview (owner 2026-11-22): basic identity only; who may view it: StudentOverviewService. */
@ApiTags('Students')
@Controller('students')
export class StudentOverviewController {
  constructor(private readonly overview: StudentOverviewService) {}

  /** Photo, name, username, country, school, grade, Olympiad level, subjects (account status for staff). 404 if not allowed. */
  @Get(':id/overview')
  @Authenticated()
  view(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.overview.overview(id, user);
  }
}
