import {
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';

import { LeaderboardService } from './leaderboard.service.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';

/**
 * Leaderboard endpoints.
 *
 * Access: any authenticated user may view leaderboards.
 * Mentors and Admins are excluded from student rankings at the query level —
 * they will not appear in any leaderboard even if authenticated.
 */
@Controller('leaderboard')
@UseGuards(JwtAuthGuard)
export class LeaderboardController {
  constructor(private readonly leaderboardService: LeaderboardService) {}

  /**
   * General leaderboard — all STUDENT users ranked by points.
   *
   * Rankings use dense ranking: equal points → equal rank.
   * Tie-breaking order: points DESC → problemsSolved DESC → joinedAt ASC.
   * Includes school name for each student (null if no school on record).
   *
   * GET /leaderboard
   */
  @Get()
  findGeneral() {
    return this.leaderboardService.findGeneral();
  }

  /**
   * School summary leaderboard — schools ranked by their aggregate student points.
   * Shows total points, student count and top student per school.
   * Useful for an inter-school comparison without exposing individual rankings.
   *
   * GET /leaderboard/schools
   */
  @Get('schools')
  findSchoolSummary() {
    return this.leaderboardService.findSchoolSummary();
  }

  /**
   * School leaderboard — students within a single school, ranked by points.
   * Only students whose school FK matches :schoolId are included.
   * Cross-school data cannot appear regardless of shared names.
   * Returns 404 if the school does not exist.
   *
   * GET /leaderboard/schools/:schoolId
   */
  @Get('schools/:schoolId')
  findBySchool(@Param('schoolId') schoolId: string) {
    return this.leaderboardService.findBySchool(schoolId);
  }
}
