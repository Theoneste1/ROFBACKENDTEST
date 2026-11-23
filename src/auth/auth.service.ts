import { HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';

import { PrismaService } from '../prisma/prisma.service.js';
import { loginRefusal } from '../users/account-status.js';
import { FormAvailabilityService } from '../forms/form-availability.service.js';
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
import { RegistrationAvatarService } from '../users/registration-avatar.service.js';
import { LOGIN_FAILURES_BEFORE_LOCK, LOGIN_LOCK_MS, LoginLimiter } from './login-limiter.js';
import type { CallerCtx } from '../common/auth-user.js';
import { storedOtherInterest } from '../users/olympiad-interests.rules.js';

export const BCRYPT_COST = 12;

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Equalises login timing when the user does not exist (computed on first use). */
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hash('timing-equaliser-not-a-password', BCRYPT_COST));

/** The roles asked their gender once at sign-in when it is missing (the roles that sign up themselves). */
export const GENDER_STEP_ROLES: readonly string[] = ['STUDENT', 'TEACHER', 'MENTOR'];

/** Profile fields returned on login and from GET /me. */
export const PROFILE_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true,
  role: true, avatarUrl: true, gradeLevel: true, homeLocation: true, olympiadInterests: true, olympiadInterestOther: true,
  // Registration details (studentRegistrationDetails): the account holder's own data.
  dateOfBirth: true, gender: true, phone: true, guardianPhone: true, country: true, homeProvince: true, homeDistrict: true, homeSector: true,
  points: true, problemsSolved: true, createdAt: true, lastLoginAt: true,
  division: { select: { id: true, code: true, name: true } },
  school:   { select: { id: true, name: true, location: true } },
} as const;

/**
 * A profile (PROFILE_SELECT) with `dateOfBirthRequired`: true for a STUDENT without a date of birth, who must give it
 * before anything else (owner decision 9.3, PUT /api/v1/me/date-of-birth). Returned on login and by GET /me.
 */
export function withProfileSteps<T extends { role: string; dateOfBirth: Date | null; gender: string | null }>(profile: T): T & { dateOfBirthRequired: boolean; genderRequired: boolean } {
  return {
    ...profile,
    dateOfBirthRequired: profile.role === 'STUDENT' && profile.dateOfBirth === null,
    // Gender step (capability genderStep; owner 2026-11-20): students, teachers and coaches without a gender (accounts
    // created before gender was asked at sign-up, or by an Administrator) give it once (PUT /me/gender).
    genderRequired: GENDER_STEP_ROLES.includes(profile.role) && profile.gender === null,
  };
}

/** Consecutive wrong passwords before an account is locked, and for how long. */
export const MAX_FAILED_LOGINS = LOGIN_FAILURES_BEFORE_LOCK;
export const LOCKOUT_MS = LOGIN_LOCK_MS;

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
    private readonly forms:         FormAvailabilityService,
    private readonly limiter:       LoginLimiter,
    private readonly registrationAvatar: RegistrationAvatarService,
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
    // The STUDENT_REGISTRATION form (open, closed or scheduled): 403 REGISTRATION_CLOSED with its closed message.
    await this.forms.assertOpen('STUDENT_REGISTRATION');

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
          olympiadInterestOther: storedOtherInterest(data.olympiadInterestOther) ?? null,
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
          olympiadInterestOther: storedOtherInterest(data.olympiadInterestOther) ?? null,
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
      // OPTIONAL picture (REG-02): PUT /auth/register/avatar within 30 minutes; registration never depends on it.
      avatarUploadToken: this.registrationAvatar.issue('STUDENT', student.created.id),
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
    // Sign-in protection, decided before the account is looked up (identical for unknown usernames).
    let decision = this.limiter.reserve(identifier, client.ip);
    const user = await this.prisma.user.findFirst({
      where: identifier.includes('@') ? { email: identifier } : { username: identifier },
      select: {
        id: true, role: true, passwordHash: true, isActive: true, isApproved: true, activatedAt: true, accountStatus: true,
        lockedUntil: true,
      },
    });

    if (!decision.ok && decision.reason === 'RATE_LIMITED') {
      // The username's limits are reached (possibly by an attacker elsewhere). An address this account has signed in
      // from successfully in the last 30 days is not held by them — otherwise an attacker hammering a username could
      // keep the student out everywhere. That address still has its own lock (5 wrong passwords → 15 minutes).
      // Attackers do not sign in from the student's addresses, so for them the answer stays the same for real and
      // unknown usernames. Only where client addresses are verified (SIGNIN_TRUSTED_CLIENT_ADDRESS=true): behind a
      // shared proxy address an attacker would share the student's "known" address.
      const known = this.limiter.trustsClientAddresses && user && client.ip ? await this.signedInFrom(user.id, client.ip) : false;
      if (!known) {
        throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_REQUESTS', 'Too many sign-in attempts. Please wait and try again.', { retryAfter: decision.retryAfterSeconds });
      }
      decision = this.limiter.reserveKnownAddress(identifier, client.ip);
    }
    const passwordMatches = await bcrypt.compare(data.password, user?.passwordHash ?? (await getDummyHash()));
    // A locked username + address answers exactly like a wrong password (the right password included), so the lock
    // reveals nothing; the password is still checked to keep timing equal. Unknown usernames count the same way.
    // An account-wide lock recorded by an earlier release (User.lockedUntil) is still honoured until it expires;
    // new locks are per username + address (LoginLimiter) and never written there.
    const legacyLocked = !!user?.lockedUntil && user.lockedUntil > new Date();
    if (!decision.ok || legacyLocked || !user || !user.passwordHash || !passwordMatches) {
      if (decision.ok && !legacyLocked && !passwordMatches && this.limiter.failed(decision.pair) && user) await this.auditLock(user.id, client.ip);
      throw new UnauthorizedException('Invalid username or password.');
    }
    this.limiter.succeeded(decision.pair);

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
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_PENDING_APPROVAL', 'Your account is waiting for an administrator to approve it. You will receive an e-mail when it is approved; then sign in again.');
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

    return { ...tokens, user: withProfileSteps(profile) };
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
  /** Whether this account signed in successfully from this address in the last 30 days (LOGIN audit rows). */
  private async signedInFrom(userId: string, address: string): Promise<boolean> {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60_000);
    const row = await this.prisma.auditLog.findFirst({
      where: { action: 'LOGIN', entityId: userId, createdAt: { gte: since }, metadata: { path: ['ip'], equals: address } },
      select: { id: true },
    });
    return row !== null;
  }

  /** The lock is scoped to this address (owner approval 2026-11-18); the account stays usable from every other one. */
  private auditLock(userId: string, address: string | undefined) {
    return this.audit.log({
      actorId: null, action: 'LOCK_ACCOUNT', entity: 'User', entityId: userId,
      metadata: { attempts: LOGIN_FAILURES_BEFORE_LOCK, scope: 'ADDRESS', ip: address ?? null, minutes: LOGIN_LOCK_MS / 60_000 },
    });
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
      // A password reset is the remedy for sign-in locks (no Administrator control): it also ends a lock recorded by
      // the earlier release (User.lockedUntil); the address locks are cleared below.
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null } });
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

    // A new password ends this account's sign-in locks, from every address.
    const owner = await this.prisma.user.findUnique({ where: { id: record.userId }, select: { username: true, email: true } });
    if (owner) { this.limiter.clear(owner.username); this.limiter.clear(owner.email); }
    await this.accountEmails.passwordChanged(record.userId);
    return { message: 'Password updated. Please log in with your new password.' };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { passwordHash: true, role: true },
    });
    if (!user?.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'WRONG_PASSWORD', 'Your current password is not correct. Type it again, or sign out and use "Forgot password" if you do not remember it.');
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
