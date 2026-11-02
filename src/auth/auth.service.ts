import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { RegisterStudentDto } from './dto/register-student.dto.js';
import { RegisterAdminDto } from './dto/register-admin.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma:   PrismaService,
    private readonly jwt:      JwtService,
    private readonly audit:    AuditService,
  ) {}

  // ─── Student Registration ──────────────────────────────────────────────────

  async registerStudent(data: RegisterStudentDto) {
    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: data.username }, { email: data.email }],
      },
    });

    if (existing) {
      throw new BadRequestException('Username or email is already in use.');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    // ── School: find existing record by normalised name, or create it ────────
    // schoolName and schoolLocation are already normalised by the DTO Transform.
    const school = await this.prisma.school.upsert({
      where:  { name: data.schoolName },
      update: {},                           // no changes if it already exists
      create: { name: data.schoolName, location: data.schoolLocation },
    });

    const student = await this.prisma.user.create({
      data: {
        firstName:    data.firstName,
        lastName:     data.lastName,
        username:     data.username,
        email:        data.email,
        passwordHash,
        role:         'STUDENT',
        schoolId:     school.id,
        homeLocation: data.homeLocation,
      },
    });

    await this.audit.log({
      actorId:   student.id,
      actorRole: 'STUDENT',
      action:    'REGISTER',
      entity:    'User',
      entityId:  student.id,
      metadata:  {
        username:       student.username,
        email:          student.email,
        schoolName:     school.name,
        schoolLocation: school.location,
      },
    });

    return {
      id:           student.id,
      firstName:    student.firstName,
      lastName:     student.lastName,
      username:     student.username,
      email:        student.email,
      role:         student.role,
      homeLocation: student.homeLocation,
      school: {
        id:       school.id,
        name:     school.name,
        location: school.location,
      },
    };
  }

  // ─── Admin Registration (restricted — only existing admins or first-time seed) 

  async registerAdmin(data: RegisterAdminDto, requestingUserId?: string) {
    // If requestingUserId is provided the caller must already be an ADMIN.
    // This is enforced by the controller guard; we double-check here for safety.
    if (requestingUserId) {
      const caller = await this.prisma.user.findUnique({
        where: { id: requestingUserId },
      });
      if (!caller || caller.role !== 'ADMIN') {
        throw new ForbiddenException('Only admins can create admin accounts.');
      }
    }

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: data.username }, { email: data.email }],
      },
    });

    if (existing) {
      throw new BadRequestException('Username or email is already in use.');
    }

    const passwordHash = await bcrypt.hash(data.password, 10);

    const admin = await this.prisma.user.create({
      data: {
        firstName: data.firstName,
        lastName:  data.lastName,
        username:  data.username,
        email:     data.email,
        passwordHash,
        role: 'ADMIN',
      },
    });

    await this.audit.log({
      actorId:   requestingUserId ?? admin.id,
      actorRole: 'ADMIN',
      action:    'CREATE_ADMIN_ACCOUNT',
      entity:    'User',
      entityId:  admin.id,
      metadata:  { username: admin.username, email: admin.email },
    });

    return {
      id:        admin.id,
      firstName: admin.firstName,
      lastName:  admin.lastName,
      username:  admin.username,
      email:     admin.email,
      role:      admin.role,
    };
  }

  // ─── Login (all roles) ─────────────────────────────────────────────────────

  async login(data: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { username: data.username },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid username or password.');
    }

    const passwordMatches = await bcrypt.compare(data.password, user.passwordHash);

    if (!passwordMatches) {
      throw new UnauthorizedException('Invalid username or password.');
    }

    // jti (JWT ID) is embedded so we can blacklist specific tokens on logout.
    const jti = randomUUID();

    const payload = {
      sub:      user.id,
      username: user.username,
      role:     user.role,
      jti,
    };

    const accessToken = await this.jwt.signAsync(payload);

    await this.audit.log({
      actorId:   user.id,
      actorRole: user.role,
      action:    'LOGIN',
      entity:    'User',
      entityId:  user.id,
      metadata:  { username: user.username },
    });

    return { access_token: accessToken };
  }

  // ─── Logout ────────────────────────────────────────────────────────────────

  async logout(jti: string, expiresAt: Date, actorId: string, actorRole: string) {
    // upsert is idempotent: calling logout twice with the same token does not
    // throw a unique-constraint error — the second call is a silent no-op.
    await this.prisma.tokenBlacklist.upsert({
      where:  { jti },
      create: { jti, expiresAt },
      update: {},   // already blacklisted — nothing to change
    });

    await this.audit.log({
      actorId,
      actorRole,
      action:   'LOGOUT',
      entity:   'User',
      entityId: actorId,
    });
  }

  // ─── Token blacklist check (called from JWT strategy) ─────────────────────

  async isTokenBlacklisted(jti: string): Promise<boolean> {
    const entry = await this.prisma.tokenBlacklist.findUnique({
      where: { jti },
    });
    return entry !== null;
  }
}
