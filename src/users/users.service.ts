import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';

/** Fields that are safe to return to callers — passwordHash is never included. */
const SAFE_SELECT = {
  id:             true,
  firstName:      true,
  lastName:       true,
  username:       true,
  email:          true,
  provider:       true,
  role:           true,
  isApproved:     true,
  avatarUrl:      true,
  points:         true,
  problemsSolved: true,
  homeLocation:   true,
  school: {
    select: {
      id:       true,
      name:     true,
      location: true,
    },
  },
  createdAt:      true,
  updatedAt:      true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── List users with optional filters ──────────────────────────────────────
  async findAll(filters?: {
    role?:       string;
    schoolId?:   string;
    isApproved?: boolean;
    search?:     string;
    page?:       number;
    limit?:      number;
  }) {
    const page  = filters?.page  ?? 1;
    const limit = Math.min(filters?.limit ?? 50, 200);
    const skip  = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (filters?.role)       where['role']       = filters.role;
    if (filters?.schoolId)   where['schoolId']   = filters.schoolId;
    if (filters?.isApproved !== undefined) where['isApproved'] = filters.isApproved;
    if (filters?.search) {
      const term = filters.search;
      where['OR'] = [
        { firstName: { contains: term, mode: 'insensitive' } },
        { lastName:  { contains: term, mode: 'insensitive' } },
        { username:  { contains: term, mode: 'insensitive' } },
        { email:     { contains: term, mode: 'insensitive' } },
      ];
    }

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select:  SAFE_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take:    limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { data: users, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  // ─── Create a user (admin only — role defaults to STUDENT) ─────────────────
  async create(data: CreateUserDto) {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: data.username }, { email: data.email }],
      },
    });

    if (existing) {
      throw new BadRequestException('Username or email is already in use.');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    return this.prisma.user.create({
      data: {
        firstName:    data.firstName,
        lastName:     data.lastName,
        username:     data.username,
        email:        data.email,
        passwordHash,
        role:         data.role ?? 'STUDENT',
      },
      select: SAFE_SELECT,
    });
  }

  // ─── Get a single user ──────────────────────────────────────────────────────
  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id },
      select: SAFE_SELECT,
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found.`);
    }

    return user;
  }

  // ─── Update a user ──────────────────────────────────────────────────────────
  async update(id: string, data: UpdateUserDto) {
    // Ensure the user exists first.
    await this.findOne(id);

    const updateData: {
      firstName?:    string;
      lastName?:     string;
      username?:     string;
      email?:        string;
      passwordHash?: string;
    } = {};

    if (data.firstName !== undefined) updateData.firstName = data.firstName;
    if (data.lastName  !== undefined) updateData.lastName  = data.lastName;
    if (data.username  !== undefined) updateData.username  = data.username;
    if (data.email     !== undefined) updateData.email     = data.email;
    if (data.password  !== undefined) {
      updateData.passwordHash = await bcrypt.hash(data.password, 10);
    }

    if (Object.keys(updateData).length === 0) {
      throw new BadRequestException('At least one field must be provided.');
    }

    return this.prisma.user.update({
      where:  { id },
      data:   updateData,
      select: SAFE_SELECT,
    });
  }

  // ─── Delete a user ──────────────────────────────────────────────────────────
  async delete(id: string) {
    await this.findOne(id);

    await this.prisma.user.delete({ where: { id } });

    return { message: `User ${id} deleted successfully.` };
  }

  // ─── Increment points and problemsSolved ────────────────────────────────────
  async updateProgress(userId: string, points: number) {
    await this.findOne(userId);

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        points:         { increment: points },
        problemsSolved: { increment: 1 },
      },
      select: {
        id:             true,
        username:       true,
        points:         true,
        problemsSolved: true,
      },
    });
  }
}
