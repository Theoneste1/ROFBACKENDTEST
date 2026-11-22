/**
 * Teacher self-registration (owner-approved): a public application, reviewed by an Administrator.
 *
 * No User, school assignment or student access exists until approval. Approval creates the TEACHER
 * account and a TeacherSchoolAssignment (the existing mechanism that scopes Teachers to VERIFIED students
 * of their schools). No school is ever created here: for a missing school the Administrator first creates
 * it through POST /admin/schools (or picks an existing one) and approves with its id.
 */
import { homePlaceText, resolveHomePlace } from '../common/home-place.js';
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcrypt';

import { PrismaService } from '../prisma/prisma.service.js';
import { FormAvailabilityService } from '../forms/form-availability.service.js';
import { AuditService } from '../audit/audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ActivationService, type IssuedActivation } from '../auth/activation.service.js';
import { BCRYPT_COST } from '../auth/auth.service.js';
import { RoleAssignmentPolicy, roleFlagOn } from '../auth/role-assignment.policy.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { CallerCtx } from '../common/auth-user.js';
import { normalisePhone } from '../schools/directory/school-contacts.js';
import { TEACHER_SCHOOL_WHERE, directoryPlaceProblem, publicDirectoryHasPlace } from '../schools/school-directory.js';
import { RWANDA, codeProblems } from '../schools/school-rules.js';
import { AdminSchoolsService } from '../schools/admin-schools.service.js';
import { PermissionService } from '../auth/permission.service.js';
import type { AuthUser } from '../common/auth-user.js';
import type { CreateSchoolDto } from '../schools/dto/admin-school.dto.js';
import { lockSchoolsForUse } from '../schools/school-usage.js';
import { lockSchoolPrimary, lockTeacherAccount, roleForNewLink } from '../teachers/primary-teacher.js';
import type { Prisma } from '../generated/prisma/client.js';
import { DecisionNotificationsService } from '../decision-notifications/decision-notifications.service.js';
import { DecisionEvents } from '../decision-notifications/decision-content.js';
import { Events } from '../notifications/events.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RegistrationAvatarService, carryApplicationAvatar } from '../users/registration-avatar.service.js';
import { ApplicationInfoRequestsService, INFO_REQUEST_SELECT } from '../application-info-requests/application-info-requests.service.js';
import {
  ApproveTeacherApplicationDto, ListTeacherApplicationsDto, RegisterTeacherDto, RejectTeacherApplicationDto,
  VerifyTeacherApplicationSchoolDto,
} from './dto/teacher-application.dto.js';
import {
  applicationAlreadyDecided, approvalSchoolId, assertPasswordsMatch, identityTaken, registrationClosed,
  schoolAlreadyVerified, schoolChoice, schoolNotVerified, teacherRegistrationOpen, unknownSchool,
} from './teacher-application.rules.js';
import { storedOtherInterest } from '../users/olympiad-interests.rules.js';

const SCHOOL_SELECT = { id: true, name: true, code: true, province: true, district: true, sector: true } as const;

/** What the admin endpoints return (never passwordHash). */
export const APPLICATION_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true, phone: true, country: true,
  olympiadInterests: true, olympiadInterestOther: true, status: true,
  school: { select: SCHOOL_SELECT },
  proposedSchoolName: true, schoolProvince: true, schoolDistrict: true, schoolSector: true,
  proposedSchoolCode: true, proposedSchoolCell: true, proposedSchoolVillage: true, proposedSchoolOwnership: true, proposedSchoolAccommodation: true,
  homeProvince: true, homeDistrict: true, homeSector: true, createdAt: true, decidedAt: true,
  decidedBy: { select: { id: true, firstName: true, lastName: true } },
  rejectionReason: true, decisionNote: true, userId: true,
  assignedSchool: { select: { id: true, name: true, code: true } },
  schoolVerifiedAt: true,
  // Whether a picture was sent (reviewed before approval: GET /admin/teacher-applications/:id/avatar).
  avatarFileId: true,
  schoolVerifiedBy: { select: { id: true, firstName: true, lastName: true } },
  position: true, yearsOfExperience: true,
  // "Request more information" (ADR-009): newest first; the open one (answeredAt and cancelledAt null) is the current question.
  infoRequests: { select: INFO_REQUEST_SELECT, orderBy: { requestedAt: 'desc' }, take: 10 },
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
    private readonly events:     EventEmitter2,
    private readonly forms:      FormAvailabilityService,
    private readonly infoRequests: ApplicationInfoRequestsService,
    private readonly notifications: NotificationsService,
    private readonly registrationAvatar: RegistrationAvatarService,
    private readonly schools: AdminSchoolsService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * An unlisted school's official code (owner 2026-11-22): 6 digits that fit the province (400 INVALID_SCHOOL_CODE),
   * and not in the directory yet (409 SCHOOL_CODE_LISTED, naming the school so the applicant can choose it instead).
   */
  private async assertProposedCodeFree(code: string, province: string) {
    const problems = codeProblems(code, province);
    if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SCHOOL_CODE', problems[0], { code });
    const listed = await this.prisma.school.findUnique({ where: { code }, select: { id: true, name: true, district: true, sector: true, isActive: true } });
    if (!listed) return;
    const where = [listed.district, listed.sector].filter(Boolean).join(', ');
    throw new AppError(HttpStatus.CONFLICT, 'SCHOOL_CODE_LISTED', listed.isActive
      ? `This code belongs to ${listed.name}${where ? ` (${where})` : ''}, which is already listed. Choose it in the school list above instead.`
      : `This code belongs to ${listed.name}, which is not open for registration. Contact the Rwanda Olympiad Foundation.`,
    { code, school: listed });
  }

  /**
   * One-step approval of an unlisted-school application (owner 2026-11-22): the school is created from the details the
   * applicant gave — no retyping — with the same checks as an Administrator's POST /admin/schools (official place, code
   * free, possible duplicates confirmed), or, when its code was listed since (e.g. by a directory sync), that school is
   * used. The application's school is then verified (the existing verify step, audited), and the approval continues.
   * Two committed steps: when the approval itself fails afterwards, the school and the verification stay and approving
   * again completes it.
   */
  private async createProposedSchool(application: {
    id: string; proposedSchoolName: string | null; proposedSchoolCode: string | null; schoolProvince: string; schoolDistrict: string;
    schoolSector: string | null; proposedSchoolCell: string | null; proposedSchoolVillage: string | null;
    proposedSchoolOwnership: string | null; proposedSchoolAccommodation: 'DAY' | 'BOARDING' | 'MIXED' | null;
  }, confirmPossibleDuplicate: boolean | undefined, caller: CallerCtx) {
    const code = application.proposedSchoolCode!;
    // Creating a school is the Administrator's schools.manage right (as POST /admin/schools).
    if (!this.permissions.has(caller as AuthUser, 'schools.manage')) {
      throw new AppError(HttpStatus.FORBIDDEN, 'SCHOOL_MANAGE_REQUIRED', 'Approving this application creates its school, which needs the right to manage schools.');
    }
    const listed = await this.prisma.school.findUnique({ where: { code }, select: { id: true, isActive: true, countryCode: true } });
    let schoolId: string;
    if (listed) {
      if (!listed.isActive || listed.countryCode !== RWANDA) throw unknownSchool(listed.id);
      schoolId = listed.id;
    } else {
      const created = await this.schools.create({
        name: application.proposedSchoolName!, countryCode: RWANDA, code,
        province: application.schoolProvince, district: application.schoolDistrict, sector: application.schoolSector ?? undefined,
        cell: application.proposedSchoolCell ?? undefined, village: application.proposedSchoolVillage ?? undefined,
        ownership: (application.proposedSchoolOwnership ?? undefined) as CreateSchoolDto['ownership'],
        accommodation: application.proposedSchoolAccommodation ?? undefined, confirmPossibleDuplicate,
      } as CreateSchoolDto, caller);
      schoolId = created.id;
    }
    await this.verifySchool(application.id, { schoolId, note: listed ? 'The proposed code was listed meanwhile: that school is used.' : 'Created from the application (one-step approval).' }, caller);
  }

  // ─── Public ────────────────────────────────────────────────────────────────

  /**
   * Open only while TEACHERS_ENABLED is on AND the TEACHER_REGISTRATION form is open (open, closed or scheduled;
   * registration.teacherSelfSignup reads and writes that form).
   */
  async isOpen(): Promise<boolean> {
    return teacherRegistrationOpen(roleFlagOn('TEACHER', this.config), await this.forms.isOpen('TEACHER_REGISTRATION'));
  }

  async availability() {
    return { open: await this.isOpen() };
  }

  async register(dto: RegisterTeacherDto) {
    // 403 REGISTRATION_CLOSED with the form's closed message (also while the Teacher role is disabled).
    if (!(await this.isOpen())) {
      await this.forms.assertOpen('TEACHER_REGISTRATION');
      throw registrationClosed();
    }
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

    // "My school is not listed" (owner 2026-11-22): the official code must fit the province and must not be listed yet —
    // a listed code means the school is in the list above (chosen by code, it gets the account at once).
    if (choice.kind === 'MISSING') await this.assertProposedCodeFree(choice.code, dto.schoolProvince);

    let school: { id: string; name: string; code: string | null; province: string | null; district: string | null; sector: string | null } | null = null;
    if (choice.kind === 'LISTED') {
      // An official-code school, or one without a code that an administrator created AND verified
      // (owner decision 2026-11-14); chosen by id, a code is never invented.
      school = await this.prisma.school.findFirst({ where: { id: choice.schoolId, ...TEACHER_SCHOOL_WHERE }, select: SCHOOL_SELECT });
      if (!school) throw unknownSchool(choice.schoolId);
      if (school.province !== dto.schoolProvince || school.district !== dto.schoolDistrict) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_LOCATION_MISMATCH',
          'This school is not in the province and district you chose.',
          { schoolId: school.id, province: dto.schoolProvince, district: dto.schoolDistrict });
      }
    }

    // Home location (homeLocationRules): the official place for Rwanda, nothing for another home country.
    const home = await resolveHomePlace(this.prisma, dto.country, dto);

    await this.assertIdentityFree(dto.username, dto.email);
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);

    // Self-registration (owner, 2026-11-21): a teacher who chose a LISTED school (its code identifies it) gets the account
    // at once — the application is created and approved in one transaction, with the same code as an Administrator's
    // approval (the school link, primary when the school has none, the audit entry). A school that is not listed still
    // needs an Administrator (there is no code to match the school's students with).
    const instant = school !== null && (await this.prisma.school.count({ where: { id: school.id, isActive: true, countryCode: RWANDA } })) === 1;
    const verify = instant ? await this.settings.get('registration.requireEmailVerification') : false;
    let issued: IssuedActivation | null = null;
    let account: { id: string; username: string } | null = null;

    const created = await this.prisma.$transaction(async (tx) => {
      const application = await tx.teacherApplication.create({
        data: {
          firstName: dto.firstName, lastName: dto.lastName, username: dto.username, email: dto.email,
          passwordHash, phone, country: dto.country, gender: dto.gender, olympiadInterests: dto.olympiadInterests,
          olympiadInterestOther: storedOtherInterest(dto.olympiadInterestOther) ?? null,
          schoolId: school?.id ?? null,
          proposedSchoolName: choice.kind === 'MISSING' ? choice.proposedSchoolName : null,
          schoolProvince: dto.schoolProvince, schoolDistrict: dto.schoolDistrict,
          // A listed school's sector comes from the directory.
          schoolSector: choice.kind === 'MISSING' ? choice.schoolSector : school?.sector ?? null,
          ...(choice.kind === 'MISSING' && {
            proposedSchoolCode: choice.code, proposedSchoolCell: choice.cell, proposedSchoolVillage: choice.village,
            proposedSchoolOwnership: choice.ownership, proposedSchoolAccommodation: choice.accommodation,
          }),
          homeProvince: home.homeProvince, homeDistrict: home.homeDistrict, homeSector: home.homeSector,
          position: dto.position ?? null, yearsOfExperience: dto.yearsOfExperience ?? null,
        },
        select: { id: true, status: true, proposedSchoolName: true },
      });
      await this.audit.log({
        actorId: null, actorRole: 'ANONYMOUS',
        action: 'SUBMIT_TEACHER_APPLICATION', entity: 'TeacherApplication', entityId: application.id,
        metadata: { schoolId: school?.id ?? null, missingSchool: choice.kind === 'MISSING', olympiadInterests: dto.olympiadInterests },
      }, tx);
      if (instant && school) {
        const done = await this.approveInTx(tx, application.id, school.id, { id: null, role: 'ANONYMOUS' }, {
          note: null, approvePicture: false, verify, selfRegistration: true,
        });
        issued = done.issued;
        account = { id: done.user.id, username: done.user.username };
        return { ...application, status: 'APPROVED' as const };
      }
      return application;
    }).catch((e: unknown) => {
      // A concurrent PENDING application with this username or e-mail (partial unique indexes).
      throw isUniqueViolation(e) ? identityTaken() : e;
    });

    const acc = account as { id: string; username: string } | null;
    if (acc) {
      // The account exists: the confirmation e-mail when required, else the teacher signs in at once.
      if (issued) await this.activation.send(issued);
      return {
        id: created.id,
        status: created.status,
        requiresApproval: false as const,
        accountCreated: true as const,
        username: acc.username,
        emailVerificationRequired: verify,
        school,
        proposedSchoolName: null,
        // OPTIONAL picture (REG-02): PUT /auth/register/avatar within 30 minutes — on the new account.
        avatarUploadToken: this.registrationAvatar.issue('TEACHER', acc.id),
      };
    }

    // Administrators are told once per application, after it committed (owner decision 5).
    this.events.emit(Events.TeacherApplicationSubmitted, { applicationId: created.id });

    return {
      id: created.id,
      status: created.status,
      requiresApproval: true as const,
      accountCreated: false as const,
      school,
      proposedSchoolName: created.proposedSchoolName,
      // OPTIONAL picture (REG-02): PUT /auth/register/avatar within 30 minutes.
      avatarUploadToken: this.registrationAvatar.issue('TEACHER_APPLICATION', created.id),
    };
  }

  // ─── Administrators (users.manageTeachers + the TEACHER role flag) ─────────

  async list(q: ListTeacherApplicationsDto, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
    const { page, limit, skip, take } = pageArgs(q);
    const where = teacherApplicationListWhere(q);
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
    let application = await this.prisma.teacherApplication.findUnique({ where: { id } });
    if (!application) throw notFound();
    if (application.status !== 'PENDING' || !application.passwordHash) throw applicationAlreadyDecided();
    if (application.proposedSchoolName !== null && !application.schoolVerifiedAt) {
      // With the school's official details (owner 2026-11-22): one step — the school is created from them and verified.
      // Without them (an application made before): the Administrator verifies the school first (POST …/:id/school).
      if (!application.proposedSchoolCode || dto.schoolId !== undefined) throw schoolNotVerified();
      await this.createProposedSchool(application, dto.confirmPossibleDuplicate, caller);
      application = await this.prisma.teacherApplication.findUniqueOrThrow({ where: { id } });
    }

    const schoolId = approvalSchoolId(application.schoolId, dto.schoolId);
    const school = await this.prisma.school.findUnique({ where: { id: schoolId }, select: { id: true, isActive: true, countryCode: true } });
    if (!school || !school.isActive || school.countryCode !== RWANDA) throw unknownSchool(schoolId);

    const verify = await this.settings.get('registration.requireEmailVerification');
    let issued: IssuedActivation | null = null;
    let notice: string | null = null;

    const teacher = await this.prisma.$transaction(async (tx) => {
      const done = await this.approveInTx(tx, id, schoolId, { id: caller.id, role: caller.role }, {
        note: dto.note ?? null, approvePicture: dto.approvePicture === true, verify, selfRegistration: false,
      });
      issued = done.issued;
      notice = done.notice;
      return done.user;
    }).catch((e: unknown) => {
      throw isUniqueViolation(e) ? identityTaken() : e;
    });

    // The approval is committed: hand the notice to the dispatcher first, so a failure while queuing the
    // confirmation e-mail below can no longer hold it back until the next sweep (L1).
    this.notices.dispatchAfterCommit([notice]);
    // With e-mail verification on, the confirmation e-mail is sent as before; the approval notice tells
    // the teacher to use it (no login link until the account is activated).
    if (issued) await this.activation.send(issued);

    return {
      application: await this.prisma.teacherApplication.findUniqueOrThrow({ where: { id }, select: APPLICATION_SELECT }),
      teacher,
      emailVerificationRequired: verify,
    };
  }

  /**
   * The approval, inside the caller's transaction: the application claimed (APPROVED), the Teacher account, its link to
   * the school (primary when the school has none), the picture decision, the e-mail verification when required, the
   * approval notice (not for self-registration) and the audit entry. Shared by an Administrator's approval and by
   * self-registration with a listed school (owner 2026-11-21: no approval step; actor = the system, id null).
   */
  private async approveInTx(
    tx: Prisma.TransactionClient, id: string, schoolId: string, actor: { id: string | null; role: string },
    opts: { note: string | null; approvePicture: boolean; verify: boolean; selfRegistration: boolean },
  ): Promise<{ user: { id: string; firstName: string; lastName: string; username: string; email: string; role: string }; issued: IssuedActivation | null; notice: string | null }> {
      const now = new Date();
      // The row as it is now, locked (an answer to a request for more information may have corrected it, e.g. the
      // phone; the answer path locks the application first too). Read before the claim, which clears the password hash.
      await tx.$queryRaw`SELECT 1 FROM "TeacherApplication" WHERE "id" = ${id} FOR UPDATE`;
      const application = await tx.teacherApplication.findUniqueOrThrow({ where: { id } });
      if (application.status !== 'PENDING' || !application.passwordHash) throw applicationAlreadyDecided();
      // Claim the application: only one concurrent decision can succeed. The picture moves to the account (below).
      const { count } = await tx.teacherApplication.updateMany({
        where: { id, status: 'PENDING' },
        data:  {
          status: 'APPROVED', passwordHash: null, decidedAt: now, decidedById: actor.id,
          assignedSchoolId: schoolId, decisionNote: opts.note, avatarFileId: null,
        },
      });
      if (count === 0) throw applicationAlreadyDecided();
      // An unanswered request for more information stops working (ADR-009).
      await this.infoRequests.cancelOpen(tx, 'TEACHER', id);
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
          phone: application.phone, country: application.country, gender: application.gender,
          // Home location (homeLocationRules): the place in Rwanda ("Sector, District" for existing displays).
          homeProvince: application.homeProvince, homeDistrict: application.homeDistrict, homeSector: application.homeSector,
          homeLocation: homePlaceText(application),
          // The applicant chose this password; the address may still need confirming.
          activatedAt: opts.verify ? null : now,
        },
        select: { id: true, firstName: true, lastName: true, username: true, email: true, role: true },
      });
      // Picture moderation: only a picture the Administrator approved after seeing it (else discarded, cleaned up).
      const picture = !application.avatarFileId ? 'NONE' : opts.approvePicture ? 'APPROVED' : 'DISCARDED';
      if (picture === 'APPROVED') await carryApplicationAvatar(tx, user.id, application.avatarFileId);   // REG-02
      // The first approved teacher of a school without an active primary becomes its primary teacher (owner decision
      // 2026-11-19); concurrent approvals of the same school are serialised by the school's primary lock.
      const accountStatus = await lockTeacherAccount(tx, user.id);
      await lockSchoolPrimary(tx, [schoolId]);
      const role = await roleForNewLink(tx, schoolId, accountStatus);
      const assignment = await tx.teacherSchoolAssignment.create({
        data: { teacherId: user.id, schoolId, assignedById: actor.id, role }, select: { id: true },
      });
      await tx.teacherApplication.update({ where: { id }, data: { userId: user.id } });
      const issued = opts.verify ? await this.activation.issue(user.id, 'EMAIL_VERIFICATION', actor.id, tx) : null;

      // Decision 10: null while teacher self-registration is off (no approval notice). A teacher who registered with a
      // listed school (no decision by anyone) gets no approval notice: they are signed in at once.
      const notice = opts.selfRegistration ? null : await this.notices.enqueue(tx, {
        type: DecisionEvents.TeacherApplicationApproved, dedupeKey: `${DecisionEvents.TeacherApplicationApproved}:${id}`,
        recipient: { userId: user.id, email: user.email, firstName: application.firstName },
        entity: { type: 'TeacherApplication', id }, payload: { activated: !opts.verify },
      });
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role,
        action: opts.selfRegistration ? 'TEACHER_SELF_REGISTERED' : 'APPROVE_TEACHER_APPLICATION', entity: 'TeacherApplication', entityId: id,
        metadata: {
          newUserId: user.id, schoolId, assignmentId: assignment.id, role, missingSchool: application.proposedSchoolName !== null, picture,
          approvalNotice: opts.selfRegistration ? 'NOT_SENT_SELF_REGISTERED' : notice ? 'QUEUED' : 'NOT_SENT_SELF_REGISTRATION_OFF',
        },
      }, tx);
      return { user, issued, notice };
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

    const school = await this.prisma.school.findUnique({ where: { id: dto.schoolId }, select: { id: true, name: true, code: true, isActive: true, countryCode: true } });
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
      // Decision 10: null while teacher self-registration is off (no school-verified notice to the applicant).
      notice = await this.notices.enqueue(tx, {
        type: DecisionEvents.SchoolRequestVerified, dedupeKey: `${DecisionEvents.SchoolRequestVerified}:teacher-application:${id}`,
        // No account yet: e-mail only, to the address given in the application.
        recipient: { userId: null, email: application.email, firstName: application.firstName },
        entity: { type: 'TeacherApplication', id }, payload: { schoolName: school.name, officialDirectory: school.code !== null, audience: 'TEACHER_APPLICANT' },
      });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role,
        action: 'VERIFY_TEACHER_APPLICATION_SCHOOL', entity: 'TeacherApplication', entityId: id,
        metadata: {
          schoolId: school.id, proposedSchoolName: application.proposedSchoolName, note: dto.note ?? null,
          schoolVerifiedNotice: notice ? 'QUEUED' : 'NOT_SENT_SELF_REGISTRATION_OFF',
        },
      }, tx);
      return tx.teacherApplication.findUniqueOrThrow({ where: { id }, select: APPLICATION_SELECT });
    });
    this.notices.dispatchAfterCommit([notice]);
    return result;
  }

  /**
   * Reject: no account and no assignment; the reason and decider are recorded, the password hash cleared.
   * No rejection notice exists (decision 10 would suppress one while self-registration is off).
   */
  /** Ask the applicant for more information (ADR-009): the application stays PENDING; e-mailed one-time link. */
  async requestInfo(id: string, question: string, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
    await this.infoRequests.request('TEACHER', id, question, caller);
    return this.prisma.teacherApplication.findUniqueOrThrow({ where: { id }, select: APPLICATION_SELECT });
  }

  async reject(id: string, dto: RejectTeacherApplicationDto, caller: CallerCtx) {
    await this.roles.assertCanAssign(caller, 'TEACHER');
    const rejected = await this.prisma.$transaction((tx) => this.rejectInTx(tx, id, dto, caller));
    // The applicant learns the decision and its reason (REG-10). After commit; a mail failure never undoes the decision.
    await this.rejectionEmail(rejected, dto.reason);
    return rejected;
  }

  /**
   * reject() inside the caller's transaction, after the caller checked assertCanAssign(caller, 'TEACHER') (also each
   * record of a TEACHER_APPLICATION bulk reject; ctx.operationId audited). The e-mail is the caller's, after commit.
   */
  async rejectInTx(tx: Prisma.TransactionClient, id: string, dto: RejectTeacherApplicationDto, caller: CallerCtx, ctx: { operationId?: string } = {}) {
    const existing = await tx.teacherApplication.findUnique({ where: { id }, select: { id: true } });
    if (!existing) throw notFound();
    const { count } = await tx.teacherApplication.updateMany({
      where: { id, status: 'PENDING' },
      // A rejected application keeps no picture (the file is then cleaned up as an orphan).
      data:  { status: 'REJECTED', passwordHash: null, decidedAt: new Date(), decidedById: caller.id, rejectionReason: dto.reason, avatarFileId: null },
    });
    if (count === 0) throw applicationAlreadyDecided();
    await this.infoRequests.cancelOpen(tx, 'TEACHER', id);
    await this.audit.log({
      actorId: caller.id, actorRole: caller.role,
      action: 'REJECT_TEACHER_APPLICATION', entity: 'TeacherApplication', entityId: id,
      // The append-only record of the decision (L2): who decided and why, as stored on the application.
      metadata: { reason: dto.reason, decidedById: caller.id, ...(ctx.operationId && { operationId: ctx.operationId }) },
    }, tx);
    return tx.teacherApplication.findUniqueOrThrow({ where: { id }, select: APPLICATION_SELECT });
  }

  /** The rejection e-mail (REG-10), queued after the decision committed; a failure is ignored. */
  rejectionEmail(rejected: { email: string; firstName: string }, reason: string) {
    return this.notifications.queueEmail(rejected.email, 'Your teacher application',
      'Thank you for applying to join the Rwanda Olympiad Foundation platform as a Teacher. ' +
      `Your application was not approved at this time.\n\nReason: ${reason}`,
      { firstName: rejected.firstName }).catch(() => undefined);
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

/** The filters of GET /admin/teacher-applications (and of the TEACHER_APPLICATION bulk selection). */
export function teacherApplicationListWhere(q: { status?: Prisma.TeacherApplicationWhereInput['status'] & string }): Prisma.TeacherApplicationWhereInput {
  return q.status ? { status: q.status } : {};
}

const notFound = () => new NotFoundException('Teacher application not found.');
