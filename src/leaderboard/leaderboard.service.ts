import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank:           number;
  id:             string;
  firstName:      string;
  lastName:       string;
  username:       string;
  avatarUrl:      string | null;
  points:         number;
  problemsSolved: number;
  school:         { id: string; name: string; location: string } | null;
}

// ─── Ranking metric ───────────────────────────────────────────────────────────
//
// Primary:   points DESC          (awarded only on published result — no double-awarding)
// Secondary: problemsSolved DESC  (more problems solved breaks ties)
// Tertiary:  createdAt ASC        (earlier registration breaks remaining ties — stable)
//
// Dense ranking: equal points → equal rank.
// Example: scores 100, 100, 80, 60 → ranks 1, 1, 2, 3  (not 1, 1, 3, 4).

function assignRanks(rows: Omit<LeaderboardEntry, 'rank'>[]): LeaderboardEntry[] {
  const result: LeaderboardEntry[] = [];
  let rank     = 1;
  let lastPts  = -1;
  let lastSolv = -1;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Two students share a rank only when both points AND problemsSolved match.
    if (row.points !== lastPts || row.problemsSolved !== lastSolv) {
      rank   = i + 1;  // dense rank = position after all higher-ranked entries
      lastPts  = row.points;
      lastSolv = row.problemsSolved;
    }
    result.push({ rank, ...row });
  }

  return result;
}

@Injectable()
export class LeaderboardService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── General leaderboard ──────────────────────────────────────────────────
  //
  // All STUDENT users ranked by points (published results only — enforced by
  // the points-increment-on-publish logic in SubmissionsService).
  // Mentors and Admins are excluded by the role filter.
  // Students with no points are included (they rank at the bottom).
  //
  async findGeneral(): Promise<LeaderboardEntry[]> {
    const rows = await this.prisma.user.findMany({
      where: { role: 'STUDENT' },
      select: {
        id:             true,
        firstName:      true,
        lastName:       true,
        username:       true,
        avatarUrl:      true,
        points:         true,
        problemsSolved: true,
        school: {
          select: { id: true, name: true, location: true },
        },
      },
      orderBy: [
        { points:         'desc' },
        { problemsSolved: 'desc' },
        { createdAt:      'asc'  },  // stable tie-breaker
      ],
    });

    return assignRanks(rows);
  }

  // ─── School leaderboard ───────────────────────────────────────────────────
  //
  // Ranks students within a single school.
  // Enforces school isolation — only students whose school FK matches the
  // requested schoolId are included.
  // Students from other schools never appear, even if they somehow share the
  // same school name string.
  //
  async findBySchool(schoolId: string): Promise<LeaderboardEntry[]> {
    // Verify the school exists first so we return 404, not an empty list.
    const school = await this.prisma.school.findUnique({
      where:  { id: schoolId },
      select: { id: true, name: true, location: true },
    });

    if (!school) {
      throw new NotFoundException(`School not found.`);
    }

    const rows = await this.prisma.user.findMany({
      where: {
        role:     'STUDENT',
        schoolId,                 // strict FK filter — no cross-school leakage
      },
      select: {
        id:             true,
        firstName:      true,
        lastName:       true,
        username:       true,
        avatarUrl:      true,
        points:         true,
        problemsSolved: true,
        school: {
          select: { id: true, name: true, location: true },
        },
      },
      orderBy: [
        { points:         'desc' },
        { problemsSolved: 'desc' },
        { createdAt:      'asc'  },
      ],
    });

    return assignRanks(rows);
  }

  // ─── School summary leaderboard ───────────────────────────────────────────
  //
  // Ranks schools by their aggregate student points.
  // Useful for a "school vs school" overview without exposing individual student data.
  // Uses a raw aggregate query for performance at scale.
  //
  async findSchoolSummary(): Promise<
    Array<{
      rank:           number;
      schoolId:       string;
      schoolName:     string;
      schoolLocation: string;
      totalPoints:    number;
      studentCount:   number;
      topStudent:     { username: string; points: number } | null;
    }>
  > {
    // Aggregate total points and count per school in one DB round-trip.
    const aggregates = await this.prisma.user.groupBy({
      by:    ['schoolId'],
      where: { role: 'STUDENT', schoolId: { not: null } },
      _sum:  { points: true },
      _count: { id: true },
      orderBy: { _sum: { points: 'desc' } },
    });

    if (aggregates.length === 0) return [];

    // Fetch school names for all referenced school IDs.
    const schoolIds = aggregates.map((a) => a.schoolId as string);
    const schools   = await this.prisma.school.findMany({
      where:  { id: { in: schoolIds } },
      select: { id: true, name: true, location: true },
    });
    const schoolMap = new Map(schools.map((s) => [s.id, s]));

    // Fetch the top-scoring student per school.
    const topStudents = await this.prisma.user.findMany({
      where: { role: 'STUDENT', schoolId: { in: schoolIds } },
      select: {
        schoolId: true,
        username: true,
        points:   true,
      },
      orderBy: [{ points: 'desc' }, { problemsSolved: 'desc' }],
    });

    // Build a map: schoolId → top student (first match = highest points).
    const topStudentMap = new Map<string, { username: string; points: number }>();
    for (const s of topStudents) {
      if (s.schoolId && !topStudentMap.has(s.schoolId)) {
        topStudentMap.set(s.schoolId, { username: s.username, points: s.points });
      }
    }

    // Assign dense ranks based on total points.
    let rank     = 1;
    let lastPts  = -1;

    return aggregates.map((agg, i) => {
      const totalPoints = agg._sum.points ?? 0;
      const school      = schoolMap.get(agg.schoolId as string);

      if (totalPoints !== lastPts) {
        rank    = i + 1;
        lastPts = totalPoints;
      }

      return {
        rank,
        schoolId:       agg.schoolId as string,
        schoolName:     school?.name     ?? 'Unknown',
        schoolLocation: school?.location ?? 'Unknown',
        totalPoints,
        studentCount:   agg._count.id,
        topStudent:     topStudentMap.get(agg.schoolId as string) ?? null,
      };
    });
  }
}
