import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../common/pagination.js';
import { PUBLIC_SCHOOL_WHERE } from './school-directory.js';
import { RWANDA } from './school-rules.js';

/** The public search result: unchanged fields (code null for a school without an official code). */
const SEARCH_SELECT = { id: true, code: true, name: true, location: true, district: true, sector: true } as const;
/** At most this many words of a search term are matched (each must be found). */
const MAX_SEARCH_WORDS = 6;

/** Places offered by GET /schools/locations (PR B): those of active, official, Rwandan schools. */
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
   * Public autocomplete for the sign-up form (P1-11): active Rwandan schools by name, code prefix or
   * place (province, district, sector or location text). Owner decision 2026-11-14: schools WITHOUT
   * an official code are offered too (`code: null`; never an invented code) — registration and claims
   * send the chosen school's `code`, or its internal `id` as `schoolId` when it has none.
   * Inactive schools are not offered.
   *
   * Matching: schools whose name contains the whole term, or whose code starts with it, come first
   * (as before); then schools where EVERY word of the term is found in the name, the code (prefix)
   * or the place — so "Saint Gabriel Ngoma" or "Ngoma Huye" find a school by name and location.
   * Each group is ordered by name; the total stays capped (10, or 200 with a district / sector).
   *
   * `level` (school directory S1): only schools offering that education level. The response never
   * contains contacts, and programmes (reviewed or not) are not part of it.
   */
  async search(term: string | undefined, place: { province?: string; district?: string; sector?: string; level?: string } = {}) {
    const q = term?.trim();
    const byPlace = !!(place.district || place.sector);
    if (!byPlace && (!q || q.length < 2)) return [];
    const take = byPlace ? 200 : 10;
    const scope = {
      ...PUBLIC_SCHOOL_WHERE,
      ...(place.province && { province: place.province }),
      ...(place.district && { district: place.district }),
      ...(place.sector && { sector: place.sector }),
      ...(place.level && { levels: { some: { levelCode: place.level } } }),
    };
    const find = (where: Prisma.SchoolWhereInput, limit: number) => this.prisma.school.findMany({
      where, select: SEARCH_SELECT, orderBy: { name: 'asc' }, take: limit,
    });
    if (!q) return find(scope, take);
    const first = await find({ ...scope, OR: [{ name: { contains: q, mode: 'insensitive' } }, { code: { startsWith: q } }] }, take);
    if (first.length >= take) return first;
    const words = q.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_WORDS);
    const more = await find({
      ...scope,
      id: { notIn: first.map((s) => s.id) },
      AND: words.map((w) => ({ OR: [
        { name: { contains: w, mode: 'insensitive' as const } },
        { code: { startsWith: w } },
        { location: { contains: w, mode: 'insensitive' as const } },
        { province: { contains: w, mode: 'insensitive' as const } },
        { district: { contains: w, mode: 'insensitive' as const } },
        { sector: { contains: w, mode: 'insensitive' as const } },
      ] })),
    }, take - first.length);
    return [...first, ...more];
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
