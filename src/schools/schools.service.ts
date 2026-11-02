import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class SchoolsService {
  constructor(private readonly prisma: PrismaService) {}

  /** List all schools, ordered by name. */
  async findAll() {
    return this.prisma.school.findMany({
      orderBy: { name: 'asc' },
      select: {
        id:        true,
        name:      true,
        location:  true,
        createdAt: true,
        _count:    { select: { students: true } },
      },
    });
  }

  /** Get a single school with its enrolled students (names + usernames). */
  async findOne(id: string) {
    const school = await this.prisma.school.findUnique({
      where: { id },
      select: {
        id:        true,
        name:      true,
        location:  true,
        createdAt: true,
        students: {
          select: {
            id:        true,
            firstName: true,
            lastName:  true,
            username:  true,
            email:     true,
            points:    true,
          },
          orderBy: { firstName: 'asc' },
        },
      },
    });

    if (!school) throw new NotFoundException(`School ${id} not found.`);

    return school;
  }
}
