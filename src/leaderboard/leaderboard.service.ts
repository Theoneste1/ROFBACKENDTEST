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
  username:       string;
  firstName:      string;
  lastName:       string;
  avatarUrl:      string | null;
  points:         number;
  problemsSolved: number;
  schoolId:       string | null;
  schoolName:     string | null;
  /** General board only: the level (division) and whether the school is verified. */
  levelCode?:     string | null;
  levelName?:     string | null;
  schoolVerified?: boolean | null;
}

/** The student (`u`) holds a current VERIFIED affiliation for their school. */
const VERIFIED_AT_SCHOOL = Prisma.sql`EXISTS (SELECT 1 FROM "StudentSchoolAffiliation" a
  WHERE a."studentId" = u."id" AND a."supersededAt" IS NULL AND a."status" = 'VERIFIED' AND a."schoolId" = u."schoolId")`;

@Injectable()
export class LeaderboardService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly settings:  SettingsService,
    private readonly access:    AccessService,
  ) {}

  /**
   * Ranked students of one division, optionally narrowed to a school. A school filter lists
   * only students whose membership of that school is VERIFIED. Each row (owner 2026-11-25): the picture, the name,
   * the school the student studies at — with `verified` false while the school has not confirmed it —
   * the level (division) and the points.
   */
  async findGeneral(user: AuthUser, q: LeaderboardQueryDto) {
    const divisionId = await this.resolveDivision(user, q.divisionId);
    const { page, limit, skip, take } = pageArgs(q);

    const filter = Prisma.sql`
      u."role" = 'STUDENT' AND u."isActive" = true AND u."divisionId" = ${divisionId}
      ${q.schoolId ? Prisma.sql`AND u."schoolId" = ${q.schoolId} AND ${VERIFIED_AT_SCHOOL}` : Prisma.empty}`;

    const [rows, countRows] = await Promise.all([
      this.prisma.$queryRaw<RankedRow[]>`
        SELECT RANK() OVER (ORDER BY u."points" DESC, u."problemsSolved" DESC) AS "rank",
               u."id", u."username", u."firstName", u."lastName", u."avatarUrl", u."points", u."problemsSolved",
               s."id" AS "schoolId", s."name" AS "schoolName", (${VERIFIED_AT_SCHOOL}) AS "schoolVerified",
               d."code" AS "levelCode", d."name" AS "levelName"
        FROM "User" u
        LEFT JOIN "School" s ON s."id" = u."schoolId"
        LEFT JOIN "Division" d ON d."id" = u."divisionId"
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
               u."id", u."username", u."firstName", u."lastName", u."avatarUrl", u."points", u."problemsSolved",
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

  /** Schools ranked by total points of their VERIFIED students within a division. */
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
      WHERE u."role" = 'STUDENT' AND u."isActive" = true AND u."divisionId" = ${divisionId} AND ${VERIFIED_AT_SCHOOL}
      GROUP BY s."id", s."name", s."location"
      ORDER BY "rank" ASC, s."name" ASC
      LIMIT ${take} OFFSET ${skip}`;

    const counted = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(DISTINCT u."schoolId") AS "count" FROM "User" u
       WHERE u."role" = 'STUDENT' AND u."isActive" = true AND u."divisionId" = ${divisionId} AND u."schoolId" IS NOT NULL AND ${VERIFIED_AT_SCHOOL}`;
    const total = Number(counted[0]?.count ?? 0);

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
        throw new AppError(HttpStatus.FORBIDDEN, 'LEADERBOARD_HIDDEN', 'The leaderboard is not shown at the moment. Please check again later.');
      }
      return this.access.studentDivision(user);
    }
    if (!isStaff(user)) throw unsupportedRole();
    if (!requested) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'DIVISION_REQUIRED', 'Choose a level (division) to see its leaderboard.');
    }
    const exists = await this.prisma.division.findUnique({ where: { id: requested }, select: { id: true } });
    if (!exists) throw new NotFoundException('Division not found.');
    return requested;
  }

  /** Staff (admins, coaches) see full names; everyone else sees the student's username (owner 2026-11-27: never names). */
  private toEntry(r: RankedRow, user: AuthUser) {
    return {
      rank:           Number(r.rank),
      id:             r.id,
      displayName:    isStaff(user) ? `${r.firstName} ${r.lastName}` : r.username,
      avatarUrl:      r.avatarUrl,
      points:         r.points,
      problemsSolved: r.problemsSolved,
      // The school the student studies at; `verified` false while the school has not confirmed it (general board).
      school:         r.schoolId ? { id: r.schoolId, name: r.schoolName, ...(r.schoolVerified != null && { verified: r.schoolVerified }) } : null,
      ...(r.levelCode !== undefined && { level: r.levelCode ? { code: r.levelCode, name: r.levelName } : null }),
      isMe:           r.id === user.id,
    };
  }
}
