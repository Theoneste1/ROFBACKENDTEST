/**
 * Teacher self-registration (owner-approved): a public application, reviewed by an Administrator.
 *
 * No User, school assignment or student access exists until approval. Approval creates the TEACHER
 * account and a TeacherSchoolAssignment (the existing mechanism that scopes Teachers to VERIFIED students
 * of their schools). No school is ever created here: for a missing school the Administrator first creates
 * it through POST /admin/schools (or picks an existing one) and approves with its id.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ActivationService, type IssuedActivation } from '../auth/activation.service.js';
import { BCRYPT_COST } from '../auth/auth.service.js';
import { RoleAssignmentPolicy, roleFlagOn } from '../auth/role-assignment.policy.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { CallerCtx } from '../common/auth-user.js';
import { normalisePhone } from '../schools/directory/school-contacts.js';
import { PUBLIC_DIRECTORY, directoryPlaceProblem, publicDirectoryHasPlace } from '../schools/school-directory.js';
import { RWANDA } from '../schools/school-rules.js';
import { lockSchoolsForUse } from '../schools/school-usage.js';
import type { Prisma } from '../generated/prisma/client.js';
import { DecisionNotificationsService } from '../decision-notifications/decision-notifications.service.js';
import { DecisionEvents } from '../decision-notifications/decision-content.js';
import {
  ApproveTeacherApplicationDto, ListTeacherApplicationsDto, RegisterTeacherDto, RejectTeacherApplicationDto,
  VerifyTeacherApplicationSchoolDto,
} from './dto/teacher-application.dto.js';
import {
  applicationAlreadyDecided, approvalSchoolId, assertPasswordsMatch, identityTaken, registrationClosed,
  schoolAlreadyVerified, schoolChoice, schoolNotVerified, teacherRegistrationOpen, unknownSchool,
} from './teacher-application.rules.js';

const SCHOOL_SELECT = { id: true, name: true, code: true, province: true, district: true, sector: true } as const;

/** What the admin endpoints return (never passwordHash). */
export const APPLICATION_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true, phone: true, country: true,
  olympiadInterests: true, status: true,
  school: { select: SCHOOL_SELECT },
  proposedSchoolName: true, schoolProvince: true, schoolDistrict: true, schoolSector: true,
  homeDistrict: true, homeSector: true, createdAt: true, decidedAt: true,
  decidedBy: { select: { id: true, firstName: true, lastName: true } },
  rejectionReason: true, decisionNote: true, userId: true,
  assignedSchool: { select: { id: true, name: true, code: true } },
  schoolVerifiedAt: true,
  schoolVerifiedBy: { select: { id: true, firstName: true, lastName: true } },
} as const satisfies Prisma.TeacherApplicationSelect;

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === 'P2002';

@Injectable()
export class TeacherApplicationsService {
  constructor(
    private readonly prisma:     PrismaService,
    private readonly audit:      AuditService,
    private readonly settings:   SettingsService,
    private readonly activation: ActivationService,
    private readonly roles:      RoleAssignmentPolicy,
    private readonly config:     ConfigService,
    private readonly notices:    DecisionNotificationsService,
  ) {}

  // ─── Public ────────────────────────────────────────────────────────────────

  /** Open only while TEACHERS_ENABLED and registration.teacherSelfSignup are both on. */
  async isOpen(): Promise<boolean> {
    return teacherRegistrationOpen(roleFlagOn('TEACHER', this.config), await this.settings.get('registration.teacherSelfSignup'));
  }

  async availability() {
    return { open: await this.isOpen() };
  }

  async register(dto: RegisterTeacherDto) {
    if (!(await this.isOpen())) throw registrationClosed();
    assertPasswordsMatch(dto.password, dto.confirmPassword);
    const phone = normalisePhone(dto.phone);
    if (!phone) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_PHONE',
        'Enter a valid phone number (Rwanda: 07XXXXXXXX or +2507XXXXXXXX; elsewhere: +country number).');
    }
    const choice = schoolChoice(dto);

    // The school's place: a listed school needs a valid province → district pair, a missing one the full
    // province → district → sector hierarchy of the public directory (GET /schools/locations).
    const place = {
      province: dto.schoolProvince, district: dto.schoolDistrict,
      ...(choice.kind === 'MISSING' && { sector: choice.schoolSector }),
    };
    if (!(await publicDirectoryHasPlace(this.prisma, place))) {
      throw directoryPlaceProblem({ province: place.province, district: place.district, sector: place.sector ?? null });
    }

    let school: { id: string; name: string; code: string | null; province: string | null; district: string | null; sector: string | null } | null = null;
    if (choice.kind === 'LISTED') {
      school = await this.prisma.school.findFirst({ where: { id: choice.schoolId, ...PUBLIC_DIRECTORY }, select: SCHOOL_SELECT });
      if (!school) throw unknownSchool(choice.schoolId);
      if (school.province !== dto.schoolProvince || school.district !== dto.schoolDistrict) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_LOCATION_MISMATCH',
          'This school is not in the province and district you chose.',
          { schoolId: school.id, province: dto.schoolProvince, district: dto.schoolDistrict });
      }
    }

    if (!(await publicDirectoryHasPlace(this.prisma, { district: dto.homeDistrict, sector: dto.homeSector }))) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_HOME_LOCATION',
        `${dto.homeSector}, ${dto.homeDistrict} is not a sector of that district in the official directory.`,
        { district: dto.homeDistrict, sector: dto.homeSector });
    }

    await this.assertIdentityFree(dto.username, dto.email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    const created = await this.prisma.$transaction(async (tx) => {
      const application = await tx.teacherApplication.create({
        data: {
          firstName: dto.firstName, lastName: dto.lastName, username: dto.username, email: dto.email,
          passwordHash, phone, country: dto.country, olympiadInterests: dto.olympiadInterests,
          schoolId: school?.id ?? null,
          proposedSchoolName: choice.kind === 'MISSING' ? choice.proposedSchoolName : null,
          schoolProvince: dto.schoolProvince, schoolDistrict: dto.schoolDistrict,
          // A listed school's sector comes from the directory.
          schoolSector: choice.kind === 'MISSING' ? choice.schoolSector : school?.sector ?? null,
          homeDistrict: dto.homeDistrict, homeSector: dto.homeSector,
        },
        select: { id: true, status: true, proposedSchoolName: true },
      });
      await this.audit.log({
        actorId: null, actorRole: 'ANONYMOUS',
        action: 'SUBMIT_TEACHER_APPLICATION', entity: 'TeacherApplication', entityId: application.id,
        metadata: { schoolId: school?.id ?? null, missingSchool: choice.kind === 'MISSING', olympiadInterests: dto.olympiadInterests },
      }, tx);
      return application;
    }).catch((e: unknown) => {
      // A concurrent PENDING application with this username or e-mail (partial unique indexes).
      throw isUniqueViolation(e) ? identityTaken() : e;
    });

    return {
      id: created.id,
      status: created.status,
      requiresApproval: true as const,
      school,
      proposedSchoolName: created.proposedSchoolName,
    };
  }

  // ─── Administrators (users.manageTeachers + the TEACHER role flag) ─────────

  async list(q: ListTeacherApplicationsDto, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
    const { page, limit, skip, take } = pageArgs(q);
    const where = q.status ? { status: q.status } : {};
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.teacherApplication.findMany({ where, select: APPLICATION_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip, take }),
      this.prisma.teacherApplication.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  async get(id: string, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
    const application = await this.prisma.teacherApplication.findUnique({ where: { id }, select: APPLICATION_SELECT });
    if (!application) throw notFound();
    return application;
  }

  /**
   * Approve: one transaction claims the PENDING application, re-checks the identity, creates the TEACHER
   * account and its school assignment, records the decision and clears the stored password hash.
   * With e-mail verification on, the account starts unactivated and the confirmation e-mail is sent.
   */
  async approve(id: string, dto: ApproveTeacherApplicationDto, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
    const application = await this.prisma.teacherApplication.findUnique({ where: { id } });
    if (!application) throw notFound();
    if (application.status !== 'PENDING' || !application.passwordHash) throw applicationAlreadyDecided();
    // A missing-school application: an Administrator verifies the school first (POST …/:id/school).
    if (application.proposedSchoolName !== null && !application.schoolVerifiedAt) throw schoolNotVerified();

    const schoolId = approvalSchoolId(application.schoolId, dto.schoolId);
    const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, isActive: true, countryCode: true } });
    if (!school || !school.isActive || school.countryCode !== RWANDA) throw unknownSchool(schoolId);

    const verify = await this.settings.get('registration.requireEmailVerification');
    let issued: IssuedActivation | null = null;
    let notice: string | null = null;

    const teacher = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Claim the application: only one concurrent decision can succeed.
      const { count } = await tx.teacherApplication.updateMany({
        where: { id, status: 'PENDING' },
        data:  {
          status: 'APPROVED', passwordHash: null, decidedAt: now, decidedById: caller.id,
          assignedSchoolId: schoolId, decisionNote: dto.note ?? null,
        },
      });
      if (count === 0) throw applicationAlreadyDecided();
      // The school must still be active, and stays so until commit (a deactivation waits; PR B).
      await lockSchoolsForUse(tx, [schoolId]);

      const clash = await tx.user.findFirst({
        where:  { OR: [{ username: application.username }, { email: application.email }] },
        select: { id: true },
      });
      if (clash) throw identityTaken();

      const user = await tx.user.create({
        data: {
          firstName: application.firstName, lastName: application.lastName,
          username: application.username, email: application.email,
          passwordHash: application.passwordHash, role: 'TEACHER', isApproved: true,
          phone: application.phone, country: application.country,
          // The applicant chose this password; the address may still need confirming.
          activatedAt: verify ? null : now,
        },
        select: { id: true, firstName: true, lastName: true, username: true, email: true, role: true },
      });
      const assignment = await tx.teacherSchoolAssignment.create({
        data: { teacherId: user.id, schoolId, assignedById: caller.id }, select: { id: true },
      });
      await tx.teacherApplication.update({ where: { id }, data: { userId: user.id } });
      if (verify) issued = await this.activation.issue(user.id, 'EMAIL_VERIFICATION', caller.id, tx);

      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'APPROVE_TEACHER_APPLICATION', entity: 'TeacherApplication', entityId: id,
        metadata: { newUserId: user.id, schoolId, assignmentId: assignment.id, missingSchool: application.proposedSchoolName !== null },
      }, tx);
      notice = await this.notices.enqueue(tx, {
        type: DecisionEvents.TeacherApplicationApproved, dedupeKey: `${DecisionEvents.TeacherApplicationApproved}:${id}`,
        recipient: { userId: user.id, email: user.email, firstName: application.firstName },
        entity: { type: 'TeacherApplication', id }, payload: { activated: !verify },
      });
      return user;
    }).catch((e: unknown) => {
      throw isUniqueViolation(e) ? identityTaken() : e;
    });

    // With e-mail verification on, the confirmation e-mail is sent as before; the approval notice tells
    // the teacher to use it (no login link until the account is activated).
    if (issued) await this.activation.send(issued);
    this.notices.dispatchAfterCommit([notice]);

    return {
      application: await this.prisma.teacherApplication.findUniqueOrThrow({ where: { id }, select: APPLICATION_SELECT }),
      teacher,
      emailVerificationRequired: verify,
    };
  }

  /**
   * Verify the school of a missing-school application (owner-approved): the Administrator links it to an
   * EXISTING active Rwandan school (created first through POST /admin/schools when needed). Records who and
   * when, sets the application's school and queues school.request.verified to the applicant's e-mail. The
   * application stays PENDING: no account and no assignment until approval.
   */
  async verifySchool(id: string, dto: VerifyTeacherApplicationSchoolDto, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
    const application = await this.prisma.teacherApplication.findUnique({
      where: { id }, select: { id: true, status: true, proposedSchoolName: true, schoolVerifiedAt: true, email: true, firstName: true },
    });
    if (!application) throw notFound();
    if (application.status !== 'PENDING') throw applicationAlreadyDecided();
    if (application.proposedSchoolName === null || application.schoolVerifiedAt) throw schoolAlreadyVerified();

    const school = await this.prisma.school.findUnique({ where: { id: dto.schoolId }, select: { id: true, name: true, isActive: true, countryCode: true } });
    if (!school || !school.isActive || school.countryCode !== RWANDA) throw unknownSchool(dto.schoolId);

    let notice: string | null = null;
    const result = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.teacherApplication.updateMany({
        where: { id, status: 'PENDING', proposedSchoolName: { not: null }, schoolVerifiedAt: null },
        data:  { schoolId: school.id, schoolVerifiedAt: new Date(), schoolVerifiedById: caller.id },
      });
      if (count === 0) {
        const now = await tx.teacherApplication.findUnique({ where: { id }, select: { status: true } });
        throw now?.status === 'PENDING' ? schoolAlreadyVerified() : applicationAlreadyDecided();
      }
      // The school must still be active, and stays so until commit.
      await lockSchoolsForUse(tx, [school.id]);
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'VERIFY_TEACHER_APPLICATION_SCHOOL', entity: 'TeacherApplication', entityId: id,
        metadata: { schoolId: school.id, proposedSchoolName: application.proposedSchoolName, note: dto.note ?? null },
      }, tx);
      notice = await this.notices.enqueue(tx, {
        type: DecisionEvents.SchoolRequestVerified, dedupeKey: `${DecisionEvents.SchoolRequestVerified}:teacher-application:${id}`,
        // No account yet: e-mail only, to the address given in the application.
        recipient: { userId: null, email: application.email, firstName: application.firstName },
        entity: { type: 'TeacherApplication', id }, payload: { schoolName: school.name },
      });
      return tx.teacherApplication.findUniqueOrThrow({ where: { id }, select: APPLICATION_SELECT });
    });
    this.notices.dispatchAfterCommit([notice]);
    return result;
  }

  /** Reject: no account and no assignment; the reason and decider are recorded, the password hash cleared. */
  async reject(id: string, dto: RejectTeacherApplicationDto, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.teacherApplication.findUnique({ where: { id }, select: { id: true } });
      if (!existing) throw notFound();
      const { count } = await tx.teacherApplication.updateMany({
        where: { id, status: 'PENDING' },
        data:  { status: 'REJECTED', passwordHash: null, decidedAt: new Date(), decidedById: caller.id, rejectionReason: dto.reason },
      });
      if (count === 0) throw applicationAlreadyDecided();
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'REJECT_TEACHER_APPLICATION', entity: 'TeacherApplication', entityId: id,
      }, tx);
      return tx.teacherApplication.findUniqueOrThrow({ where: { id }, select: APPLICATION_SELECT });
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  /** A User, a PENDING coach application or a PENDING teacher application holds the username or e-mail. */
  private async assertIdentityFree(username: string, email: string) {
    const OR = [{ username }, { email }];
    const [user, mentorRequest, teacherApplication] = await Promise.all([
      this.prisma.user.findFirst({ where: { OR }, select: { id: true } }),
      this.prisma.mentorRequest.findFirst({ where: { OR, status: 'PENDING' }, select: { id: true } }),
      this.prisma.teacherApplication.findFirst({ where: { OR, status: 'PENDING' }, select: { id: true } }),
    ]);
    if (user || mentorRequest || teacherApplication) throw identityTaken();
  }
}

const notFound = () => new NotFoundException('Teacher application not found.');
