import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../common/pagination.js';
import { RWANDA } from './school-rules.js';

/** What the public directory shows (PR B): active, official, Rwandan schools only. */
const PUBLIC_DIRECTORY = { code: { not: null }, countryCode: RWANDA, isActive: true } as const;

@Injectable()
export class SchoolsService {
  constructor(private readonly prisma: PrismaService) {}

  /** List schools with student counts, ordered by name. */
  async findAll(q: PaginationQueryDto & { search?: string }) {
    const { page, limit, skip, take } = pageArgs(q);
    const where = q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.school.findMany({
        where, skip, take,
        orderBy: { name: 'asc' },
        select: {
          id: true, name: true, location: true, code: true, district: true, sector: true, ownership: true, createdAt: true,
          _count: { select: { students: true } },
        },
      }),
      this.prisma.school.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /**
   * Public autocomplete for the sign-up form (P1-11): active official schools only, by name or
   * code prefix; registration sends the chosen `code`. Inactive schools are not offered.
   */
  async search(term: string | undefined, place: { province?: string; district?: string; sector?: string } = {}) {
    const q = term?.trim();
    const byPlace = !!(place.district || place.sector);
    if (!byPlace && (!q || q.length < 2)) return [];
    return this.prisma.school.findMany({
      where: {
        ...PUBLIC_DIRECTORY,
        ...(place.province && { province: place.province }),
        ...(place.district && { district: place.district }),
        ...(place.sector && { sector: place.sector }),
        ...(q && { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { code: { startsWith: q } }] }),
      },
      select:  { id: true, code: true, name: true, location: true, district: true, sector: true },
      orderBy: { name: 'asc' },
      take:    byPlace ? 200 : 10,
    });
  }

  /** Provinces → districts → sectors that have an active official school (ordered by code). */
  async locations() {
    const rows = await this.prisma.school.groupBy({
      by: ['province', 'district', 'sector'], where: PUBLIC_DIRECTORY, _min: { code: true },
    });
    rows.sort((a, b) => (a._min.code ?? '').localeCompare(b._min.code ?? ''));
    const provinces = new Map<string, Map<string, Set<string>>>();
    for (const r of rows) {
      if (!r.province || !r.district || !r.sector) continue;
      const districts = provinces.get(r.province) ?? new Map<string, Set<string>>();
      provinces.set(r.province, districts);
      const sectors = districts.get(r.district) ?? new Set<string>();
      districts.set(r.district, sectors);
      sectors.add(r.sector);
    }
    return [...provinces].map(([province, districts]) => ({
      province,
      districts: [...districts].map(([district, sectors]) => ({ district, sectors: [...sectors].sort() })),
    }));
  }

  /** A school with its students (names, grade, points — no contact details). */
  async findOne(id: string, q: PaginationQueryDto) {
    const school = await this.prisma.school.findUnique({
      where:  { id },
      select: { id: true, name: true, location: true, code: true, district: true, sector: true, ownership: true, createdAt: true },
    });
    if (!school) throw new NotFoundException(`School ${id} not found.`);

    const { page, limit, skip, take } = pageArgs(q);
    const where = { schoolId: id, role: 'STUDENT' as const };
    const [students, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, skip, take,
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        select: {
          id: true, firstName: true, lastName: true, username: true,
          gradeLevel: true, points: true, isActive: true,
          division: { select: { code: true, name: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return { ...school, students: paginated(students, total, page, limit) };
  }
}
