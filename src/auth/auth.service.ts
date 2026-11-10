import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DivisionsService } from '../divisions/divisions.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { AccountEmailsService } from '../notifications/account-emails.service.js';
import { AcademicYearsService } from '../academic-years/academic-years.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { ActivationService } from './activation.service.js';
import { AppError } from '../common/errors/app-error.js';
import { TokenService, hashToken, type ClientInfo } from './token.service.js';
import { RegisterStudentDto } from './dto/register-student.dto.js';
import { RegisterAdminDto } from './dto/register-admin.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RoleAssignmentPolicy } from './role-assignment.policy.js';
import { ensureDefaultMembership } from '../programmes/programme-membership.js';
import { schoolKey } from '../schools/school-key.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { CallerCtx } from '../common/auth-user.js';

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


/** Consecutive wrong passwords before an account is locked, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma:        PrismaService,
    private readonly tokens:        TokenService,
    private readonly audit:         AuditService,
    private readonly settings:      SettingsService,
    private readonly divisions:     DivisionsService,
    private readonly notifications: NotificationsService,
    private readonly academicYears: AcademicYearsService,
    private readonly activity:      ActivityService,
    private readonly activation:    ActivationService,
    private readonly accountEmails: AccountEmailsService,
    private readonly roles:         RoleAssignmentPolicy,
  ) {}

  // ─── Student Registration ──────────────────────────────────────────────────

  /**
   * The official school a registration names. Rwanda (default): by code (unknown → 400),
   * or a unique legacy name match. Another country: none — the name stays unverified and
   * is never matched to a Rwandan school; a Rwandan school code is refused.
   */
  private async registrationSchool(tx: Prisma.TransactionClient, data: RegisterStudentDto) {
    if ((data.country ?? 'RW') !== 'RW') {
      if (data.schoolCode !== undefined) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_CODE_RWANDA_ONLY', 'School codes are for schools in Rwanda. Enter your school\'s name.');
      }
      return null;
    }
    if (data.schoolCode !== undefined) {
      const byCode = await tx.school.findUnique({ where: { code: data.schoolCode }, select: { id: true, code: true, name: true } });
      if (!byCode) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL_CODE', 'No school has this code. Choose your school from the list.');
      return byCode;
    }
    const matches = await tx.school.findMany({
      where: { code: { not: null }, nameKey: schoolKey(data.schoolName ?? '') }, select: { id: true, code: true, name: true }, take: 2,
    });
    return matches.length === 1 ? matches[0] : null;
  }

  async registerStudent(data: RegisterStudentDto) {
    if (!(await this.settings.get('registration.studentSelfSignup'))) {
      throw new AppError(HttpStatus.FORBIDDEN, 'REGISTRATION_CLOSED', 'Student self-registration is currently closed.');
    }

    await this.assertIdentityFree(data.username, data.email);

    const requiresApproval     = await this.settings.get('registration.studentRequiresApproval');
    const requiresVerification = await this.settings.get('registration.requireEmailVerification');
    const passwordHash         = await bcrypt.hash(data.password, BCRYPT_COST);
    const divisionId       = await this.divisions.idForGrade(data.gradeLevel);

    const student = await this.prisma.$transaction(async (tx) => {
      // School (P1-11): the official school with this code; or, for a legacy name, the one
      // official school with that normalised name — none when it matches no school or several.
      // Registration never creates a school.
      const school = await this.registrationSchool(tx, data);

      const created = await tx.user.create({
        data: {
          firstName:    data.firstName,
          lastName:     data.lastName,
          username:     data.username,
          email:        data.email,
          passwordHash,
          role:         'STUDENT',
          isApproved:   !requiresApproval,
          activatedAt:  requiresVerification ? null : new Date(),
          gradeLevel:   data.gradeLevel,
          divisionId,
          schoolId:     school?.id ?? null,
          homeLocation: data.homeLocation,
        },
        select: PROFILE_SELECT,
      });

      // Per-year enrolment record (fails the registration if no year is active).
      await this.academicYears.enrollInCurrentYear(tx, created.id, data.gradeLevel, school?.id ?? null);
      // Mathematics programme membership (self-registration: no actor). P1-07, K6.
      await ensureDefaultMembership(tx, { id: created.id, role: 'STUDENT' }, null);

      await this.audit.log({
        actorId:   created.id,
        actorRole: 'STUDENT',
        action:    'REGISTER',
        entity:    'User',
        entityId:  created.id,
        metadata:  {
          gradeLevel: data.gradeLevel, country: data.country ?? 'RW', schoolCode: school?.code ?? null, schoolName: school?.name ?? null,
          ...(data.schoolCode === undefined && { schoolNameEntered: data.schoolName, schoolMatched: !!school }),
          // Not linked to a canonical School: the affiliation stays unverified until an Administrator confirms it.
          schoolVerified: !!school,
        },
      }, tx);

      const verification = requiresVerification
        ? await this.activation.issue(created.id, 'EMAIL_VERIFICATION', null, tx)
        : null;

      return { created, verification };
    });

    if (student.verification) await this.activation.send(student.verification);
    else await this.accountEmails.welcome(student.created.id);

    return {
      ...student.created,
      requiresApproval,
      requiresEmailVerification: requiresVerification,
    };
  }

  // ─── Admin Registration (ADMIN only — enforced by the controller) ──────────

  async registerAdmin(data: RegisterAdminDto, caller: CallerCtx) {
    const requestingUserId = caller.id;
    await this.roles.assertCanAssign(caller, 'ADMIN');
    await this.assertIdentityFree(data.username, data.email);

    const admin = await this.prisma.user.create({
      data: {
        firstName:    data.firstName,
        lastName:     data.lastName,
        username:     data.username,
        email:        data.email,
        passwordHash: await bcrypt.hash(data.password, BCRYPT_COST),
        role:         'ADMIN',
        activatedAt:  new Date(),
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
      select: {
        id: true, role: true, passwordHash: true, isActive: true, isApproved: true, activatedAt: true,
        failedLoginCount: true, lockedUntil: true,
      },
    });

    const passwordMatches = await bcrypt.compare(data.password, user?.passwordHash ?? (await getDummyHash()));
    // A locked account answers exactly like a wrong password, so the lock
    // reveals nothing; the password is still checked to keep timing equal.
    const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
    if (!user || !user.passwordHash || !passwordMatches || locked) {
      if (user && !locked && user.passwordHash && !passwordMatches) await this.recordFailedLogin(user.id, user.failedLoginCount);
      throw new UnauthorizedException('Invalid username or password.');
    }

    // Account state is only revealed after a correct password.
    if (!user.isActive) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_SUSPENDED', 'This account has been suspended.');
    }
    if (!user.activatedAt) {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'ACCOUNT_NOT_ACTIVATED',
        'Please activate your account using the link we e-mailed you (or request a new one).',
      );
    }
    if (!user.isApproved) {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_PENDING_APPROVAL', 'This account is waiting for administrator approval.');
    }

    const tokens = await this.tokens.issue(user.id, client);
    const profile = await this.prisma.user.update({
      where:  { id: user.id },
      data:   { lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null },
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
    this.activity.record(user.id, 'LOGIN');

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
  /**
   * Count a wrong password. After MAX_FAILED_LOGINS in a row the account is
   * locked for LOCKOUT_MS, whichever addresses the attempts came from (the IP
   * throttle alone can be spread across many addresses).
   */
  private async recordFailedLogin(userId: string, previous: number) {
    const count = previous + 1;
    const lock = count >= MAX_FAILED_LOGINS;
    await this.prisma.user.update({
      where: { id: userId },
      data:  lock ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MS) } : { failedLoginCount: count },
    });
    if (lock) {
      await this.audit.log({ actorId: null, action: 'LOCK_ACCOUNT', entity: 'User', entityId: userId, metadata: { attempts: count } });
    }
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where:  { email },
      select: { id: true, isActive: true, provider: true, activatedAt: true, passwordHash: true },
    });

    if (user?.isActive && user.provider === 'LOCAL') {
      if (user.activatedAt) {
        await this.sendPasswordResetLink(user.id, null);
      } else {
        // Never activated: a reset makes no sense — send a fresh activation link.
        await this.activation.issueAndSend(user.id, user.passwordHash ? 'EMAIL_VERIFICATION' : 'INVITATION', null);
      }
    }

    return { message: 'If an account exists for that e-mail, a reset link has been sent.' };
  }

  /**
   * E-mail a single-use password-reset link (30 minutes). Used by
   * "forgot password" and by administrators helping a user.
   */
  async sendPasswordResetLink(userId: string, requestedById: string | null) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where:  { id: userId },
      select: { id: true, firstName: true, email: true },
    });

    const token = randomBytes(32).toString('base64url');
    await this.prisma.$transaction([
      // Only the newest link works: earlier unused ones are retired.
      this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } }),
      this.prisma.passwordResetToken.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
      }),
    ]);
    await this.notifications.queueEmail(
      user.email,
      'Reset your password',
      'We received a request to reset the password of your account. Click the button below to choose a new password.',
      {
        firstName: user.firstName, recipientId: user.id,
        link: `/reset-password?token=${encodeURIComponent(token)}`, actionLabel: 'Reset my password',
        note: 'This link is valid for 30 minutes and can be used once. If you did not ask for a new password, ' +
          'you can ignore this e-mail: your password will not change.',
      },
    );
    await this.audit.log({
      actorId: requestedById ?? user.id, action: 'REQUEST_PASSWORD_RESET', entity: 'User', entityId: user.id,
      metadata: { byAdmin: !!requestedById },
    });
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
    await this.accountEmails.passwordChanged(record.userId);
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
    await this.accountEmails.passwordChanged(userId);

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
