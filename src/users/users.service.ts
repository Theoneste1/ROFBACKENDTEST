import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { DivisionsService } from '../divisions/divisions.service.js';
import { TokenService } from '../auth/token.service.js';
import { BCRYPT_COST, PROFILE_SELECT } from '../auth/auth.service.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import { divisionCodeForGrade, nextGrade } from '../common/grade-levels.js';
import type { CallerCtx } from '../common/auth-user.js';
import type { GradeLevel, Prisma } from '../generated/prisma/client.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import {
  ListUsersQueryDto,
  UpdateMeDto,
  UpdateUserDto,
  UpdateUserStatusDto,
} from './dto/update-user.dto.js';

/** Fields that are safe to return to admins — passwordHash is never included. */
const SAFE_SELECT = {
  ...PROFILE_SELECT,
  provider:   true,
  isApproved: true,
  isActive:   true,
  updatedAt:  true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma:    PrismaService,
    private readonly audit:     AuditService,
    private readonly divisions: DivisionsService,
    private readonly tokens:    TokenService,
  ) {}

  // ─── List users with optional filters ──────────────────────────────────────
  async findAll(q: ListUsersQueryDto) {
    const { page, limit, skip, take } = pageArgs(q);

    const where: Prisma.UserWhereInput = {
      ...(q.role       && { role: q.role }),
      ...(q.divisionId && { divisionId: q.divisionId }),
      ...(q.gradeLevel && { gradeLevel: q.gradeLevel }),
      ...(q.schoolId   && { schoolId: q.schoolId }),
      ...(q.isApproved !== undefined && { isApproved: q.isApproved }),
      ...(q.isActive   !== undefined && { isActive: q.isActive }),
      ...(q.search && {
        OR: [
          { firstName: { contains: q.search, mode: 'insensitive' } },
          { lastName:  { contains: q.search, mode: 'insensitive' } },
          { username:  { contains: q.search, mode: 'insensitive' } },
          { email:     { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({ where, select: SAFE_SELECT, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.user.count({ where }),
    ]);

    return paginated(users, total, page, limit);
  }

  // ─── Create a user (admin) ─────────────────────────────────────────────────
  async create(data: CreateUserDto, caller: CallerCtx) {
    await this.assertIdentityFree(data.username, data.email);

    const role = data.role ?? 'STUDENT';
    const studentFields = role === 'STUDENT' ? await this.studentFields(data.gradeLevel!, data.schoolId) : {};

    const user = await this.prisma.user.create({
      data: {
        firstName:    data.firstName,
        lastName:     data.lastName,
        username:     data.username,
        email:        data.email,
        passwordHash: await bcrypt.hash(data.password, BCRYPT_COST),
        role,
        homeLocation: role === 'STUDENT' ? data.homeLocation : null,
        ...studentFields,
      },
      select: SAFE_SELECT,
    });

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'CREATE_USER', entity: 'User', entityId: user.id,
      metadata: { role, username: user.username },
    });

    return user;
  }

  // ─── Get a single user ──────────────────────────────────────────────────────
  async findOne(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!user) throw new NotFoundException(`User ${id} not found.`);
    return user;
  }

  // ─── Update a user (admin) ──────────────────────────────────────────────────
  async update(id: string, data: UpdateUserDto, caller: CallerCtx) {
    const existing = await this.prisma.user.findUnique({
      where:  { id },
      select: { id: true, role: true, gradeLevel: true, username: true, email: true },
    });
    if (!existing) throw new NotFoundException(`User ${id} not found.`);

    if (Object.keys(data).length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'At least one field must be provided.');
    }
    if (id === caller.id && data.role && data.role !== existing.role) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_CHANGE_OWN_ROLE', 'You cannot change your own role.');
    }
    if ((data.username && data.username !== existing.username) || (data.email && data.email !== existing.email)) {
      await this.assertIdentityFree(
        data.username !== existing.username ? data.username : undefined,
        data.email    !== existing.email    ? data.email    : undefined,
      );
    }

    const role = data.role ?? existing.role;
    const updateData: Prisma.UserUncheckedUpdateInput = {
      firstName: data.firstName,
      lastName:  data.lastName,
      username:  data.username,
      email:     data.email,
      role,
      ...(data.password && { passwordHash: await bcrypt.hash(data.password, BCRYPT_COST) }),
    };

    if (role === 'STUDENT') {
      const grade = data.gradeLevel ?? existing.gradeLevel;
      if (!grade) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'GRADE_REQUIRED', 'Students must have a grade level.');
      }
      Object.assign(updateData, await this.studentFields(grade, data.schoolId), {
        ...(data.homeLocation !== undefined && { homeLocation: data.homeLocation }),
      });
    } else {
      // Mentors and admins carry no student data.
      Object.assign(updateData, { gradeLevel: null, divisionId: null, schoolId: null, homeLocation: null });
    }

    const user = await this.prisma.user.update({ where: { id }, data: updateData, select: SAFE_SELECT });

    if (data.password || data.role) await this.tokens.revokeAllForUser(id);

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'UPDATE_USER', entity: 'User', entityId: id,
      metadata: { fields: Object.keys(data).filter((k) => k !== 'password'), passwordChanged: !!data.password },
    });

    return user;
  }

  // ─── Suspend / activate / approve ───────────────────────────────────────────
  async updateStatus(id: string, data: UpdateUserStatusDto, caller: CallerCtx) {
    if (id === caller.id && data.isActive === false) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_SUSPEND_SELF', 'You cannot suspend your own account.');
    }
    await this.findOne(id);

    const user = await this.prisma.user.update({
      where:  { id },
      data:   { isActive: data.isActive, isApproved: data.isApproved },
      select: SAFE_SELECT,
    });

    if (data.isActive === false) await this.tokens.revokeAllForUser(id);

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'UPDATE_USER_STATUS', entity: 'User', entityId: id, metadata: { ...data },
    });
    return user;
  }

  // ─── Delete a user ──────────────────────────────────────────────────────────
  /**
   * Hard delete is only possible for accounts without academic history
   * (submissions, assignments, reviews …). Otherwise suspend the account.
   */
  async delete(id: string, caller: CallerCtx) {
    if (id === caller.id) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'CANNOT_DELETE_SELF', 'You cannot delete your own account.');
    }
    const user = await this.findOne(id);

    try {
      await this.prisma.user.delete({ where: { id } });
    } catch (err: any) {
      if (err?.code === 'P2003') {
        throw new AppError(
          HttpStatus.CONFLICT,
          'USER_HAS_HISTORY',
          'This account has academic history and cannot be deleted. Suspend it instead.',
        );
      }
      throw err;
    }

    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'DELETE_USER', entity: 'User', entityId: id, metadata: { username: user.username },
    });
    return { message: `User ${id} deleted successfully.` };
  }

  // ─── Annual promotion ───────────────────────────────────────────────────────
  /**
   * Moves every active student up one grade (S1→S2 … S5→S6), updating the
   * division where the grade crosses S3→S4. Optionally graduates S6 students
   * by deactivating them. Runs in one transaction.
   */
  async promoteStudents(graduateS6: boolean, caller: CallerCtx) {
    const grades: GradeLevel[] = ['S6', 'S5', 'S4', 'S3', 'S2', 'S1']; // top-down: no double moves
    const counts: Record<string, number> = {};
    // Resolve outside the transaction: only `tx` may be used inside it.
    const divisionFor = {
      JUNIOR: await this.divisions.idForCode('JUNIOR'),
      SENIOR: await this.divisions.idForCode('SENIOR'),
    };

    await this.prisma.$transaction(async (tx) => {
      for (const grade of grades) {
        const next = nextGrade(grade);
        if (!next) {
          if (graduateS6) {
            const r = await tx.user.updateMany({
              where: { role: 'STUDENT', gradeLevel: 'S6', isActive: true },
              data:  { isActive: false },
            });
            counts['graduated'] = r.count;
          }
          continue;
        }
        const r = await tx.user.updateMany({
          where: { role: 'STUDENT', gradeLevel: grade, isActive: true },
          data:  { gradeLevel: next, divisionId: divisionFor[divisionCodeForGrade(next)] },
        });
        counts[`${grade}->${next}`] = r.count;
      }

      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'PROMOTE_STUDENTS', entity: 'User', metadata: { graduateS6, counts },
      }, tx);
    }, { timeout: 60_000 });

    return { promoted: counts };
  }

  // ─── Self-service profile ───────────────────────────────────────────────────
  async getMe(userId: string) {
    const me = await this.prisma.user.findUnique({ where: { id: userId }, select: PROFILE_SELECT });
    if (!me) throw new NotFoundException('User not found.');
    return me;
  }

  async updateMe(userId: string, data: UpdateMeDto) {
    if (Object.keys(data).length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'At least one field must be provided.');
    }
    return this.prisma.user.update({ where: { id: userId }, data, select: PROFILE_SELECT });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async studentFields(gradeLevel: GradeLevel, schoolId?: string) {
    if (schoolId) {
      const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { id: true } });
      if (!school) throw new NotFoundException('School not found.');
    }
    return {
      gradeLevel,
      divisionId: await this.divisions.idForGrade(gradeLevel),
      ...(schoolId && { schoolId }),
    };
  }

  private async assertIdentityFree(username?: string, email?: string) {
    const or = [
      ...(username ? [{ username }] : []),
      ...(email ? [{ email }] : []),
    ];
    if (or.length === 0) return;
    const existing = await this.prisma.user.findFirst({ where: { OR: or }, select: { id: true } });
    if (existing) {
      throw new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');
    }
  }
}
