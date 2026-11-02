import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DivisionsService } from '../divisions/divisions.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AppError } from '../common/errors/app-error.js';
import { TokenService, hashToken, type ClientInfo } from './token.service.js';
import { RegisterStudentDto } from './dto/register-student.dto.js';
import { RegisterAdminDto } from './dto/register-admin.dto.js';
import { LoginDto } from './dto/login.dto.js';

export const BCRYPT_COST = 12;

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Equalises login timing when the user does not exist (computed on first use). */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash('timing-equaliser-not-a-password', BCRYPT_COST));

/** Profile fields returned on login and from GET /me. */
export const PROFILE_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true,
  role: true, avatarUrl: true, gradeLevel: true, homeLocation: true,
  points: true, problemsSolved: true, createdAt: true, lastLoginAt: true,
  division: { select: { id: true, code: true, name: true } },
  school:   { select: { id: true, name: true, location: true } },
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma:        PrismaService,
    private readonly tokens:        TokenService,
    private readonly audit:         AuditService,
    private readonly settings:      SettingsService,
    private readonly divisions:     DivisionsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ─── Student Registration ──────────────────────────────────────────────────

  async registerStudent(data: RegisterStudentDto) {
    if (!(await this.settings.get('registration.studentSelfSignup'))) {
      throw new AppError(HttpStatus.FORBIDDEN, 'REGISTRATION_CLOSED', 'Student self-registration is currently closed.');
    }

    await this.assertIdentityFree(data.username, data.email);

    const requiresApproval = await this.settings.get('registration.studentRequiresApproval');
    const passwordHash     = await bcrypt.hash(data.password, BCRYPT_COST);
    const divisionId       = await this.divisions.idForGrade(data.gradeLevel);

    const student = await this.prisma.$transaction(async (tx) => {
      // School: find existing record by normalised name, or create it.
      const school = await tx.school.upsert({
        where:  { name: data.schoolName },
        update: {},
        create: { name: data.schoolName, location: data.schoolLocation },
      });

      const created = await tx.user.create({
        data: {
          firstName:    data.firstName,
          lastName:     data.lastName,
          username:     data.username,
          email:        data.email,
          passwordHash,
          role:         'STUDENT',
          isApproved:   !requiresApproval,
          gradeLevel:   data.gradeLevel,
          divisionId,
          schoolId:     school.id,
          homeLocation: data.homeLocation,
        },
        select: PROFILE_SELECT,
      });

      await this.audit.log({
        actorId:   created.id,
        actorRole: 'STUDENT',
        action:    'REGISTER',
        entity:    'User',
        entityId:  created.id,
        metadata:  { gradeLevel: data.gradeLevel, schoolName: school.name },
      }, tx);

      return created;
    });

    return { ...student, requiresApproval };
  }

  // ─── Admin Registration (ADMIN only — enforced by the controller) ──────────

  async registerAdmin(data: RegisterAdminDto, requestingUserId: string) {
    await this.assertIdentityFree(data.username, data.email);

    const admin = await this.prisma.user.create({
      data: {
        firstName:    data.firstName,
        lastName:     data.lastName,
        username:     data.username,
        email:        data.email,
        passwordHash: await bcrypt.hash(data.password, BCRYPT_COST),
        role:         'ADMIN',
      },
      select: { id: true, firstName: true, lastName: true, username: true, email: true, role: true },
    });

    await this.audit.log({
      actorId:   requestingUserId,
      actorRole: 'ADMIN',
      action:    'CREATE_ADMIN_ACCOUNT',
      entity:    'User',
      entityId:  admin.id,
      metadata:  { username: admin.username },
    });

    return admin;
  }

  // ─── Login ─────────────────────────────────────────────────────────────────

  async login(data: LoginDto, client: ClientInfo) {
    const identifier = data.username;
    const user = await this.prisma.user.findFirst({
      where: identifier.includes('@') ? { email: identifier } : { username: identifier },
      select: { id: true, role: true, passwordHash: true, isActive: true, isApproved: true },
    });

    const passwordMatches = await bcrypt.compare(data.password, user?.passwordHash ?? (await getDummyHash()));
    if (!user || !user.passwordHash || !passwordMatches) {
      throw new UnauthorizedException('Invalid username or password.');
    }

    // Account state is only revealed after a correct password.
    if (!user.isActive) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_SUSPENDED', 'This account has been suspended.');
    }
    if (!user.isApproved) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_PENDING_APPROVAL', 'This account is waiting for administrator approval.');
    }

    const tokens = await this.tokens.issue(user.id, client);
    const profile = await this.prisma.user.update({
      where:  { id: user.id },
      data:   { lastLoginAt: new Date() },
      select: PROFILE_SELECT,
    });

    await this.audit.log({
      actorId:   user.id,
      actorRole: user.role,
      action:    'LOGIN',
      entity:    'User',
      entityId:  user.id,
      metadata:  { ip: client.ip },
    });

    return { ...tokens, user: profile };
  }

  // ─── Refresh / Logout ──────────────────────────────────────────────────────

  async refresh(refreshToken: string, client: ClientInfo) {
    const { tokens } = await this.tokens.rotate(refreshToken, client);
    return tokens;
  }

  async logout(user: { id: string; role: string; jti?: string; exp?: number }, refreshToken?: string) {
    if (user.jti) await this.tokens.blacklistAccessToken(user.jti, user.exp);
    if (refreshToken) await this.tokens.revoke(refreshToken);

    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'LOGOUT', entity: 'User', entityId: user.id,
    });
  }

  async logoutAll(user: { id: string; role: string; jti?: string; exp?: number }) {
    if (user.jti) await this.tokens.blacklistAccessToken(user.jti, user.exp);
    await this.tokens.revokeAllForUser(user.id);
    await this.audit.log({
      actorId: user.id, actorRole: user.role,
      action: 'LOGOUT_ALL_SESSIONS', entity: 'User', entityId: user.id,
    });
  }

  // ─── Passwords ─────────────────────────────────────────────────────────────

  /**
   * Always succeeds from the caller's point of view, so the endpoint cannot be
   * used to discover which e-mail addresses have accounts.
   */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where:  { email },
      select: { id: true, firstName: true, email: true, isActive: true, provider: true },
    });

    if (user?.isActive && user.provider === 'LOCAL') {
      const token = randomBytes(32).toString('base64url');
      await this.prisma.passwordResetToken.create({
        data: {
          userId:    user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
        },
      });
      await this.notifications.queueEmail(
        user.email,
        'Reset your password',
        'We received a request to reset your password. The link below is valid for 30 minutes. ' +
          'If you did not ask for this, you can ignore this e-mail.',
        {
          firstName:   user.firstName,
          recipientId: user.id,
          link:        `/reset-password?token=${encodeURIComponent(token)}`,
        },
      );
      await this.audit.log({
        actorId: user.id, action: 'REQUEST_PASSWORD_RESET', entity: 'User', entityId: user.id,
      });
    }

    return { message: 'If an account exists for that e-mail, a reset link has been sent.' };
  }

  async resetPassword(token: string, newPassword: string) {
    const record = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);

    // Mark the token used only if nobody else used it first.
    const used = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.passwordResetToken.updateMany({
        where: { id: record.id, usedAt: null },
        data:  { usedAt: new Date() },
      });
      if (count === 0) return false;
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash } });
      await this.audit.log({
        actorId: record.userId, action: 'RESET_PASSWORD', entity: 'User', entityId: record.userId,
      }, tx);
      return true;
    });
    if (!used) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
    }

    await this.tokens.revokeAllForUser(record.userId);
    return { message: 'Password updated. Please log in with your new password.' };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { passwordHash: true, role: true },
    });
    if (!user?.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'WRONG_PASSWORD', 'Your current password is incorrect.');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data:  { passwordHash: await bcrypt.hash(newPassword, BCRYPT_COST) },
    });
    await this.tokens.revokeAllForUser(userId);

    await this.audit.log({
      actorId: userId, actorRole: user.role,
      action: 'CHANGE_PASSWORD', entity: 'User', entityId: userId,
    });
    return { message: 'Password changed. Other sessions have been signed out.' };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** One message for both cases, so the endpoint can't confirm which one is taken. */
  private async assertIdentityFree(username: string, email: string) {
    const [user, request] = await Promise.all([
      this.prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } }),
      this.prisma.mentorRequest.findFirst({
        where:  { OR: [{ username }, { email }], status: 'PENDING' },
        select: { id: true },
      }),
    ]);
    if (user || request) {
      throw new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');
    }
  }
}
