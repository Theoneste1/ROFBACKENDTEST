import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AccessService } from '../common/access/access.service.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { isStaff, isStudent, unsupportedRole } from '../common/access/roles.js';
import { Prisma } from '../generated/prisma/client.js';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto.js';

// ─── Ranking metric ───────────────────────────────────────────────────────────
//
// Points are a cache of published results (see SubmissionsService), so only
// published work counts and points are never awarded twice.
//
//   Primary:   points DESC
//   Secondary: problemsSolved DESC
//
// Standard competition ranking (SQL RANK()): equal → same rank, next rank
// skips. Example: 100, 100, 80 → ranks 1, 1, 3. Remaining ties are listed in
// registration order.
//
// Leaderboards are per division — Junior and Senior students never compete
// on the same board. Only active students are ranked.

interface RankedRow {
  rank:           bigint;
  id:             string;
  firstName:      string;
  lastName:       string;
  avatarUrl:      string | null;
  points:         number;
  problemsSolved: number;
  schoolId:       string | null;
  schoolName:     string | null;
}

@Injectable()
export class LeaderboardService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly settings:  SettingsService,
    private readonly access:    AccessService,
  ) {}

  /** Ranked students of one division, optionally narrowed to a school. */
  async findGeneral(user: AuthUser, q: LeaderboardQueryDto) {
    const divisionId = await this.resolveDivision(user, q.divisionId);
    const { page, limit, skip, take } = pageArgs(q);

    const filter = Prisma.sql`
      u."role" = 'STUDENT' AND u."isActive" = true AND u."divisionId" = ${divisionId}
      ${q.schoolId ? Prisma.sql`AND u."schoolId" = ${q.schoolId}` : Prisma.empty}`;

    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<RankedRow[]>`
        SELECT RANK() OVER (ORDER BY u."points" DESC, u."problemsSolved" DESC) AS "rank",
               u."id", u."firstName", u."lastName", u."avatarUrl", u."points", u."problemsSolved",
               s."id" AS "schoolId", s."name" AS "schoolName"
        FROM "User" u
        LEFT JOIN "School" s ON s."id" = u."schoolId"
        WHERE ${filter}
        ORDER BY "rank" ASC, u."createdAt" ASC
        LIMIT ${take} OFFSET ${skip}`,
      this.prisma.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS "count" FROM "User" u WHERE ${filter}`,
    ]);

    return {
      divisionId,
      ...paginated(rows.map((r) => this.toEntry(r, user)), Number(countRows[0]?.count ?? 0), page, limit),
    };
  }

  /** The current student's own position in their division. */
  async findMine(user: AuthUser) {
    const divisionId = await this.resolveDivision(user, undefined);
    const rows = await this.prisma.$queryRaw<RankedRow[]>`
      SELECT * FROM (
        SELECT RANK() OVER (ORDER BY u."points" DESC, u."problemsSolved" DESC) AS "rank",
               u."id", u."firstName", u."lastName", u."avatarUrl", u."points", u."problemsSolved",
               u."schoolId", NULL AS "schoolName"
        FROM "User" u
        WHERE u."role" = 'STUDENT' AND u."isActive" = true AND u."divisionId" = ${divisionId}
      ) ranked
      WHERE ranked."id" = ${user.id}`;
    const total = await this.prisma.user.count({ where: { role: 'STUDENT', isActive: true, divisionId } });

    const me = rows[0];
    return {
      divisionId,
      rank:           me ? Number(me.rank) : null,
      outOf:          total,
      points:         me?.points ?? 0,
      problemsSolved: me?.problemsSolved ?? 0,
    };
  }

  /** Schools ranked by total student points within a division. */
  async findSchoolSummary(user: AuthUser, q: LeaderboardQueryDto) {
    const divisionId = await this.resolveDivision(user, q.divisionId);
    const { page, limit, skip, take } = pageArgs(q);

    const rows = await this.prisma.$queryRaw<Array<{
      rank: bigint; schoolId: string; schoolName: string; schoolLocation: string;
      totalPoints: bigint; studentCount: bigint; averagePoints: number;
    }>>`
      SELECT RANK() OVER (ORDER BY SUM(u."points") DESC) AS "rank",
             s."id" AS "schoolId", s."name" AS "schoolName", s."location" AS "schoolLocation",
             SUM(u."points") AS "totalPoints", COUNT(u."id") AS "studentCount",
             ROUND(AVG(u."points")::numeric, 1)::float AS "averagePoints"
      FROM "User" u
      JOIN "School" s ON s."id" = u."schoolId"
      WHERE u."role" = 'STUDENT' AND u."isActive" = true AND u."divisionId" = ${divisionId}
      GROUP BY s."id", s."name", s."location"
      ORDER BY "rank" ASC, s."name" ASC
      LIMIT ${take} OFFSET ${skip}`;

    const total = await this.prisma.school.count({
      where: { students: { some: { role: 'STUDENT', isActive: true, divisionId } } },
    });

    return {
      divisionId,
      ...paginated(
        rows.map((r) => ({
          rank:           Number(r.rank),
          schoolId:       r.schoolId,
          schoolName:     r.schoolName,
          schoolLocation: r.schoolLocation,
          totalPoints:    Number(r.totalPoints),
          studentCount:   Number(r.studentCount),
          averagePoints:  r.averagePoints,
        })),
        total, page, limit,
      ),
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Students always see their own division (and only if the setting allows).
   * Staff (admins, coaches) must choose a division. Any other role is refused.
   */
  private async resolveDivision(user: AuthUser, requested?: string): Promise<string> {
    if (isStudent(user)) {
      if (!(await this.settings.get('leaderboard.visibleToStudents'))) {
        throw new AppError(HttpStatus.FORBIDDEN, 'LEADERBOARD_HIDDEN', 'The leaderboard is currently not available.');
      }
      return this.access.studentDivision(user);
    }
    if (!isStaff(user)) throw unsupportedRole();
    if (!requested) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'DIVISION_REQUIRED', 'Specify divisionId.');
    }
    const exists = await this.prisma.division.findUnique({ where: { id: requested }, select: { id: true } });
    if (!exists) throw new NotFoundException('Division not found.');
    return requested;
  }

  /** Staff (admins, coaches) see full names; everyone else sees first name + last initial. */
  private toEntry(r: RankedRow, user: AuthUser) {
    return {
      rank:           Number(r.rank),
      id:             r.id,
      displayName:    isStaff(user) ? `${r.firstName} ${r.lastName}` : `${r.firstName} ${r.lastName.charAt(0)}.`,
      avatarUrl:      r.avatarUrl,
      points:         r.points,
      problemsSolved: r.problemsSolved,
      school:         r.schoolId ? { id: r.schoolId, name: r.schoolName } : null,
      isMe:           r.id === user.id,
    };
  }
}
