import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { loginRefusal } from '../users/account-status.js';
import { canonicalInterests } from '../users/olympiad-interests.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DivisionsService } from '../divisions/divisions.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { Events } from '../notifications/events.js';
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
import { RWANDA } from '../schools/school-rules.js';
import { assertDirectoryPlace, directorySchoolById, publicDirectoryHasPlace, uniqueOfficialSchoolInPlace } from '../schools/school-directory.js';
import { homePlaceOf, studentDetailAudit, studentDetailColumns, unknownHomeLocation } from './student-details.js';
import { schoolInactive } from '../schools/school-usage.js';
import { SchoolAffiliationService } from '../schools/affiliations/school-affiliation.service.js';
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
  role: true, avatarUrl: true, gradeLevel: true, homeLocation: true, olympiadInterests: true,
  // Registration details (studentRegistrationDetails): the account holder's own data.
  dateOfBirth: true, phone: true, guardianPhone: true, country: true, homeProvince: true, homeDistrict: true, homeSector: true,
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
    private readonly affiliations:  SchoolAffiliationService,
    private readonly events:        EventEmitter2,
  ) {}

  // ─── Student Registration ──────────────────────────────────────────────────

  /**
   * The official school a registration names. Rwanda (default): by code (unknown → 400), by
   * internal id (schoolId — e.g. a school without an official code; unknown → 400), or a unique
   * legacy name match. Another country: none — the name stays unverified and
   * is never matched to a Rwandan school; a Rwandan school code is refused.
   */
  private async registrationSchool(tx: Prisma.TransactionClient, data: RegisterStudentDto) {
    const placeGiven = data.schoolProvince !== undefined;   // all three, or none (DTO)
    if (data.schoolId !== undefined && data.schoolCode !== undefined) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', 'Send either schoolId or schoolCode, not both.');
    }
    if ((data.country ?? 'RW') !== 'RW') {
      if (data.schoolId !== undefined) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_DIRECTORY_RWANDA_ONLY', "The school list is Rwanda's directory; for another country enter the school's name.");
      }
      if (data.schoolCode !== undefined) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_CODE_RWANDA_ONLY', 'School codes are for schools in Rwanda. Enter your school\'s name.');
      }
      if (placeGiven) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_DIRECTORY_RWANDA_ONLY', 'Province, district and sector are Rwanda\'s directory; for another country enter the school\'s name only.');
      }
      return null;
    }
    // A school of the list by its internal id (owner decision 2026-11-14: schools without an
    // official code are chosen this way; no code is ever invented for them).
    if (data.schoolId !== undefined) return directorySchoolById(tx, data.schoolId);
    // "My school is not listed" (PR C): a place from the official directory; only an exact unique
    // active official school with this name IN THAT SECTOR is linked (still PENDING).
    if (data.schoolCode === undefined && placeGiven) {
      const place = { province: data.schoolProvince!, district: data.schoolDistrict!, sector: data.schoolSector! };
      await assertDirectoryPlace(tx, place);
      const id = await uniqueOfficialSchoolInPlace(tx, schoolKey(data.schoolName ?? ''), place);
      return id ? tx.school.findUniqueOrThrow({ where: { id }, select: { id: true, code: true, name: true } }) : null;
    }
    // Codes and name matching are for Rwandan schools only; an inactive school takes no new
    // registrations (PR B). The claim re-checks the school under a row lock.
    if (data.schoolCode !== undefined) {
      const byCode = await tx.school.findFirst({
        where: { code: data.schoolCode, countryCode: RWANDA }, select: { id: true, code: true, name: true, isActive: true },
      });
      if (!byCode) throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL_CODE', 'No school has this code. Choose your school from the list.');
      if (!byCode.isActive) throw schoolInactive(byCode.id);
      return byCode;
    }
    const matches = await tx.school.findMany({
      where: { code: { not: null }, countryCode: RWANDA, isActive: true, nameKey: schoolKey(data.schoolName ?? '') },
      select: { id: true, code: true, name: true }, take: 2,
    });
    return matches.length === 1 ? matches[0] : null;
  }

  async registerStudent(data: RegisterStudentDto) {
    if (!(await this.settings.get('registration.studentSelfSignup'))) {
      throw new AppError(HttpStatus.FORBIDDEN, 'REGISTRATION_CLOSED', 'Student self-registration is currently closed.');
    }

    // Registration details (studentRegistrationDetails): the official home place must exist (Rwanda only).
    const home = homePlaceOf(data);
    if (home && !(await publicDirectoryHasPlace(this.prisma, home))) throw unknownHomeLocation(home);

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
      // The school was chosen from the list (by code or by id), not entered by name.
      const byReference = data.schoolCode !== undefined || data.schoolId !== undefined;

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
          // homeLocation, and the registration details that were sent (date of birth, phones, own country, home place).
          ...studentDetailColumns(data, home),
          // Owner decision 8: information only (no programme membership, no permissions).
          olympiadInterests: canonicalInterests(data.olympiadInterests),
        },
        select: PROFILE_SELECT,
      });

      // Per-year enrolment record (fails the registration if no year is active).
      await this.academicYears.enrollInCurrentYear(tx, created.id, data.gradeLevel, school?.id ?? null);
      // Mathematics programme membership (self-registration: no actor). P1-07, K6.
      await ensureDefaultMembership(tx, { id: created.id, role: 'STUDENT' }, null);
      // School claim, PENDING until an Administrator verifies it (choosing a school proves nothing).
      const affiliationId = school || data.schoolName
        ? await this.affiliations.claim(tx, {
            studentId: created.id, schoolId: school?.id ?? null, source: 'REGISTRATION', reason: 'NEW_CLAIM',
            actor: { actorId: created.id, actorRole: 'STUDENT' },
            // What the student entered — kept with the place on a "not listed" claim, linked or not.
            ...((!school || (!byReference && data.schoolProvince !== undefined)) && { claimed: {
              name: data.schoolName ?? null, country: data.country ?? 'RW',
              ...(data.schoolProvince !== undefined && { province: data.schoolProvince, district: data.schoolDistrict, sector: data.schoolSector }),
            } }),
          })
        : null;

      await this.audit.log({
        actorId:   created.id,
        actorRole: 'STUDENT',
        action:    'REGISTER',
        entity:    'User',
        entityId:  created.id,
        metadata:  {
          gradeLevel: data.gradeLevel, country: data.country ?? 'RW', schoolCode: school?.code ?? null, schoolName: school?.name ?? null,
          ...(data.schoolId !== undefined && { schoolId: school?.id ?? null }),
          ...(!byReference && { schoolNameEntered: data.schoolName, schoolMatched: !!school }),
          ...(!byReference && data.schoolProvince !== undefined && {
            schoolPlaceEntered: { province: data.schoolProvince, district: data.schoolDistrict, sector: data.schoolSector },
          }),
          // Linked to a canonical School or not; membership is verified separately by an Administrator.
          schoolLinked: !!school,
          olympiadInterests: canonicalInterests(data.olympiadInterests),
          // Whether each detail was given — never a phone number or a date of birth.
          ...studentDetailAudit(data, home),
        },
      }, tx);

      const verification = requiresVerification
        ? await this.activation.issue(created.id, 'EMAIL_VERIFICATION', null, tx)
        : null;

      return { created, verification, affiliationId };
    });

    if (student.verification) await this.activation.send(student.verification);
    else await this.accountEmails.welcome(student.created.id);
    this.events.emit(Events.StudentRegistered, { userId: student.created.id, requiresApproval });

    return {
      ...student.created,
      requiresApproval,
      requiresEmailVerification: requiresVerification,
      // 'PENDING' when a school claim was created (an Administrator verifies it); null otherwise.
      schoolVerification: student.affiliationId ? ('PENDING' as const) : null,
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
        id: true, role: true, passwordHash: true, isActive: true, isApproved: true, activatedAt: true, accountStatus: true,
      },
    });

    // Reserve this attempt BEFORE the password is checked (under the user's row
    // lock), so concurrent guesses cannot all be evaluated against a stale
    // "not locked" read: at most MAX_FAILED_LOGINS guesses are ever checked
    // before the account locks, however many arrive at once.
    const attempt = user?.passwordHash ? await this.reserveLoginAttempt(user.id) : null;
    const passwordMatches = await bcrypt.compare(data.password, user?.passwordHash ?? (await getDummyHash()));
    // A locked account answers exactly like a wrong password, so the lock
    // reveals nothing; the password is still checked to keep timing equal.
    if (!user || !user.passwordHash || attempt === null || !passwordMatches) {
      if (attempt !== null && !passwordMatches) await this.recordFailedLogin(user!.id, attempt);
      throw new UnauthorizedException('Invalid username or password.');
    }

    // Account state is only revealed after a correct password. A correct
    // password never counts towards the lockout, also when the account cannot
    // sign in yet (the success path below resets the counter itself).
    if (!user.isActive || !user.activatedAt || !user.isApproved) {
      await this.prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0 } });
    }
    if (!user.isActive) {
      // Account states: ACCOUNT_DEACTIVATED, ACCOUNT_SUSPENDED (as before) or ACCOUNT_ARCHIVED.
      const refusal = loginRefusal(user.accountStatus) ?? loginRefusal('SUSPENDED')!;
      throw new AppError(HttpStatus.FORBIDDEN, refusal.code, refusal.message);
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

  /**
   * End one session. Needs no valid access token (H1): the refresh token (the
   * httpOnly cookie, or the body for non-browser clients) identifies the
   * session, so signing out after the 15-minute access token has expired still
   * revokes it on the server. An access token, if presented and still valid, is
   * blacklisted as well. Idempotent: with nothing to revoke it does nothing (and
   * writes no audit entry); the caller always clears the cookie.
   */
  async logout(input: { refreshToken?: string; accessToken?: string }) {
    const claims = input.accessToken ? await this.tokens.verifyAccessToken(input.accessToken) : null;
    if (claims?.jti) await this.tokens.blacklistAccessToken(claims.jti, claims.exp);
    const session = input.refreshToken ? await this.tokens.revoke(input.refreshToken) : null;

    const userId = session?.userId ?? claims?.sub;
    if (!userId) return;
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    await this.audit.log({
      actorId: userId, actorRole: user?.role ?? null,
      action: 'LOGOUT', entity: 'User', entityId: userId,
      metadata: { sessionRevoked: session !== null, accessTokenRevoked: Boolean(claims?.jti) },
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
   * Reserve one login attempt for a user, atomically: under the User row lock,
   * refuse (null) while the account is locked or MAX_FAILED_LOGINS attempts are
   * already counted (pending or failed); otherwise count this attempt and return
   * its number. A correct password resets the counter (login success); a wrong
   * one is settled by recordFailedLogin. The row lock is held only for this
   * short transaction, never during the bcrypt comparison.
   */
  private async reserveLoginAttempt(userId: string): Promise<number | null> {
    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
      const u = await tx.user.findUnique({ where: { id: userId }, select: { failedLoginCount: true, lockedUntil: true } });
      if (!u) return { attempt: null, lockedNow: false };
      if (u.lockedUntil && u.lockedUntil > new Date()) return { attempt: null, lockedNow: false };
      if (u.failedLoginCount >= MAX_FAILED_LOGINS) {
        // The limit is reached but nothing has locked the account yet: either the
        // deciding attempt is still being checked, or its request died before it
        // could settle. Lock now, so the account can never be stuck refusing
        // every attempt with no expiry.
        await tx.user.update({ where: { id: userId }, data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MS) } });
        return { attempt: null, lockedNow: true };
      }
      const updated = await tx.user.update({
        where:  { id: userId },
        data:   { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      return { attempt: updated.failedLoginCount, lockedNow: false };
    });
    if (result.lockedNow) await this.auditLock(userId, MAX_FAILED_LOGINS);
    return result.attempt;
  }

  /**
   * Settle a reserved attempt whose password was wrong. The attempt that
   * reaches MAX_FAILED_LOGINS locks the account for LOCKOUT_MS, whichever
   * addresses the attempts came from (the IP throttle alone can be spread across
   * many addresses). Earlier wrong attempts are already counted by the
   * reservation, so there is nothing else to write.
   */
  private async recordFailedLogin(userId: string, attempt: number) {
    if (attempt < MAX_FAILED_LOGINS) return;
    const now = new Date();
    // Conditional: a concurrent reservation may already have locked the account.
    const { count } = await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
      data:  { failedLoginCount: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) },
    });
    if (count > 0) await this.auditLock(userId, attempt);
  }

  private auditLock(userId: string, attempts: number) {
    return this.audit.log({ actorId: null, action: 'LOCK_ACCOUNT', entity: 'User', entityId: userId, metadata: { attempts } });
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
      // Every session ends in the same transaction as the password change.
      await this.tokens.revokeAllForUser(record.userId, tx);
      await this.audit.log({
        actorId: record.userId, action: 'RESET_PASSWORD', entity: 'User', entityId: record.userId,
      }, tx);
      return true;
    });
    if (!used) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_RESET_TOKEN', 'This reset link is invalid or has expired.');
    }

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

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    // The new password and the end of every session (this one included) commit together.
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { passwordHash } });
      await this.tokens.revokeAllForUser(userId, tx);
    });
    await this.accountEmails.passwordChanged(userId);

    await this.audit.log({
      actorId: userId, actorRole: user.role,
      action: 'CHANGE_PASSWORD', entity: 'User', entityId: userId,
    });
    // Every session ends, this one included (the access token used for this request is refused from now on).
    return { message: 'Password changed. Every session has been signed out, including this one; sign in again with the new password.' };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** One message for both cases, so the endpoint can't confirm which one is taken. */
  private async assertIdentityFree(username: string, email: string) {
    const [user, request, teacherApplication] = await Promise.all([
      this.prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { id: true } }),
      this.prisma.mentorRequest.findFirst({
        where:  { OR: [{ username }, { email }], status: 'PENDING' },
        select: { id: true },
      }),
      // A pending Teacher application holds its username and e-mail too (teacher self-registration).
      this.prisma.teacherApplication.findFirst({
        where:  { OR: [{ username }, { email }], status: 'PENDING' },
        select: { id: true },
      }),
    ]);
    if (user || request || teacherApplication) {
      throw new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');
    }
  }
}
