import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../common/pagination.js';

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
          id: true, name: true, location: true, createdAt: true,
          _count: { select: { students: true } },
        },
      }),
      this.prisma.school.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  /** Public autocomplete for the sign-up form: names and locations only. */
  async search(term: string) {
    if (!term || term.trim().length < 2) return [];
    return this.prisma.school.findMany({
      where:   { name: { contains: term.trim(), mode: 'insensitive' } },
      select:  { id: true, name: true, location: true },
      orderBy: { name: 'asc' },
      take:    10,
    });
  }

  /** A school with its students (names, grade, points — no contact details). */
  async findOne(id: string, q: PaginationQueryDto) {
    const school = await this.prisma.school.findUnique({
      where:  { id },
      select: { id: true, name: true, location: true, createdAt: true },
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
