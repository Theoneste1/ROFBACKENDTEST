import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { LeaderboardService } from './leaderboard.service.js';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

/**
 * Division leaderboards. Mentors and admins never appear in rankings.
 * Students see their own division only (when enabled in settings).
 */
@ApiTags('Leaderboard')
@Controller('leaderboard')
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  /** Students ranked by points (optionally within one school). */
  @Get()
  findGeneral(@CurrentUser() user: AuthUser, @Query() query: LeaderboardQueryDto) {
    return this.leaderboardService.findGeneral(user, query);
  }

  /** The current student's rank. */
  @Get('me')
  @Roles('STUDENT')
  findMine(@CurrentUser() user: AuthUser) {
    return this.leaderboardService.findMine(user);
  }

  /** Schools ranked by total student points. */
  @Get('schools')
  findSchoolSummary(@CurrentUser() user: AuthUser, @Query() query: LeaderboardQueryDto) {
    return this.leaderboardService.findSchoolSummary(user, query);
  }
}
