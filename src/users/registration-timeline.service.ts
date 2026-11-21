/**
 * Registration timeline of one account (REG-13, "view registration history"): the current stages and every
 * registration-related event, oldest first — account created (registration, invitation, creation), the Teacher /
 * Coach application it came from (submitted, questions and answers, school verification, decision), activation,
 * approval and state changes, role changes, school claim steps, the registration picture.
 * Built from the existing records (AuditLog, the application, the school claims); nothing new is stored. Each event
 * carries a fixed, safe subset of details — never e-mail addresses, phone numbers, dates of birth or raw metadata.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

const USER_ACTIONS = ['REGISTER', 'CREATE_USER', 'CREATE_ADMIN_ACCOUNT', 'INVITE_USER', 'RESEND_INVITATION', 'ACTIVATE_ACCOUNT', 'UPDATE_USER_STATUS', 'USER_STATUS_CHANGED', 'CHANGE_USER_ROLE', 'AVATAR_SET'];
const TEACHER_APP_ACTIONS = ['SUBMIT_TEACHER_APPLICATION', 'APPLICATION_INFO_REQUESTED', 'APPLICATION_INFO_ANSWERED', 'APPLICATION_AVATAR_SET', 'VERIFY_TEACHER_APPLICATION_SCHOOL', 'APPROVE_TEACHER_APPLICATION', 'REJECT_TEACHER_APPLICATION', 'TEACHER_SELF_REGISTERED'];
const COACH_APP_ACTIONS = ['SUBMIT_MENTOR_REQUEST', 'APPLICATION_INFO_REQUESTED', 'APPLICATION_INFO_ANSWERED', 'APPLICATION_AVATAR_SET', 'APPROVE_MENTOR_REQUEST', 'REJECT_MENTOR_REQUEST'];
const CLAIM_ACTIONS = ['SCHOOL_AFFILIATION_CREATED', 'SCHOOL_AFFILIATION_VERIFIED', 'SCHOOL_AFFILIATION_REJECTED', 'SCHOOL_AFFILIATION_REVOKED', 'SCHOOL_AFFILIATION_SUPERSEDED', 'SCHOOL_AFFILIATION_BACKFILL', 'SCHOOL_AFFILIATION_RESOLVED', 'SCHOOL_AFFILIATION_REOPENED'];

export const TIMELINE_LABELS: Readonly<Record<string, string>> = {
  REGISTER: 'Registered (self-registration)',
  CREATE_USER: 'Account created by an administrator',
  CREATE_ADMIN_ACCOUNT: 'Administrator account created',
  INVITE_USER: 'Invited by an administrator',
  RESEND_INVITATION: 'Invitation sent again',
  ACTIVATE_ACCOUNT: 'Account activated',
  UPDATE_USER_STATUS: 'Approval or access changed',
  USER_STATUS_CHANGED: 'Account state changed',
  CHANGE_USER_ROLE: 'Role changed',
  AVATAR_SET: 'Profile picture added',
  SUBMIT_TEACHER_APPLICATION: 'Teacher application submitted',
  SUBMIT_MENTOR_REQUEST: 'Coach application submitted',
  APPLICATION_INFO_REQUESTED: 'More information requested from the applicant',
  APPLICATION_INFO_ANSWERED: 'Applicant answered',
  APPLICATION_AVATAR_SET: 'Profile picture sent with the application',
  VERIFY_TEACHER_APPLICATION_SCHOOL: 'School of the application verified',
  APPROVE_TEACHER_APPLICATION: 'Teacher application approved',
  REJECT_TEACHER_APPLICATION: 'Teacher application rejected',
  TEACHER_SELF_REGISTERED: 'Teacher account created at sign-up (listed school: no approval needed)',
  APPROVE_MENTOR_REQUEST: 'Coach application approved',
  REJECT_MENTOR_REQUEST: 'Coach application rejected',
  SCHOOL_AFFILIATION_CREATED: 'School claim made',
  SCHOOL_AFFILIATION_VERIFIED: 'School verified by an administrator',
  SCHOOL_AFFILIATION_REJECTED: 'School claim rejected',
  SCHOOL_AFFILIATION_REVOKED: 'School verification revoked',
  SCHOOL_AFFILIATION_SUPERSEDED: 'School claim replaced',
  SCHOOL_AFFILIATION_BACKFILL: 'School claim recorded (migration)',
  SCHOOL_AFFILIATION_RESOLVED: 'School claim linked to an official school',
  SCHOOL_AFFILIATION_REOPENED: 'School claim reopened',
};

/** Actions that start an account's history (shown first when written in the same moment as other steps). */
const STARTS = ['REGISTER', 'CREATE_USER', 'CREATE_ADMIN_ACCOUNT', 'INVITE_USER', 'SUBMIT_TEACHER_APPLICATION', 'SUBMIT_MENTOR_REQUEST'];
const SAME_MOMENT_MS = 2000;

/** The only metadata fields ever returned (all non-identifying). */
const SAFE_DETAILS = ['from', 'to', 'reason', 'question', 'status', 'toStatus', 'fromStatus', 'supersedeReason', 'olympiadInterests'] as const;

function safeDetails(action: string, metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SAFE_DETAILS) {
    const v = m[k];
    if (v === undefined || v === null) continue;
    // A status change's from / to are account states or roles; student enrolment objects are not returned.
    if ((k === 'from' || k === 'to') && typeof v !== 'string') continue;
    out[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  if (action === 'APPLICATION_INFO_ANSWERED') delete out.question;
  return Object.keys(out).length ? out : null;
}

@Injectable()
export class RegistrationTimelineService {
  constructor(private readonly prisma: PrismaService) {}

  async timeline(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, username: true, role: true, createdAt: true, activatedAt: true, isApproved: true, accountStatus: true,
        schoolAffiliations: { select: { id: true, status: true, supersededAt: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found.`);

    const teacherApp = await this.prisma.teacherApplication.findFirst({ where: { userId }, select: { id: true } });
    // A coach application has no account link: the approved application with this username (usernames are unique
    // among accounts and an application only becomes an account on approval).
    const coachApp = user.role === 'MENTOR' || user.role === 'HEAD_COACH'
      ? await this.prisma.mentorRequest.findFirst({ where: { username: user.username, status: 'APPROVED' }, select: { id: true }, orderBy: { updatedAt: 'desc' } })
      : null;
    const claimIds = user.schoolAffiliations.map((a) => a.id);

    const or = [
      { entity: 'User', entityId: userId, action: { in: USER_ACTIONS } },
      ...(teacherApp ? [{ entity: 'TeacherApplication', entityId: teacherApp.id, action: { in: TEACHER_APP_ACTIONS } }] : []),
      ...(coachApp ? [{ entity: 'MentorRequest', entityId: coachApp.id, action: { in: COACH_APP_ACTIONS } }] : []),
      ...(claimIds.length ? [{ entity: 'StudentSchoolAffiliation', entityId: { in: claimIds }, action: { in: CLAIM_ACTIONS } }] : []),
    ];
    const rows = await this.prisma.auditLog.findMany({
      where: { OR: or },
      select: { id: true, action: true, actorRole: true, actorUsername: true, actorId: true, metadata: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
    });

    // An account's creation (registration, invitation, creation, application) leads its own history: steps written in
    // the same transaction (e.g. the school claim of a registration) are recorded a few milliseconds earlier or later.
    const startIdx = rows.findIndex((r) => STARTS.includes(r.action));
    if (startIdx > 0) {
      const start = rows[startIdx];
      const sameMoment = (r: { createdAt: Date }) => Math.abs(r.createdAt.getTime() - start.createdAt.getTime()) <= SAME_MOMENT_MS;
      const before = rows.slice(0, startIdx);
      const firstSame = before.findIndex(sameMoment);
      if (firstSame >= 0) { rows.splice(startIdx, 1); rows.splice(firstSame, 0, start); }
    }

    const current = user.schoolAffiliations.find((a) => a.supersededAt === null) ?? null;
    return {
      userId: user.id,
      stages: {
        created: user.createdAt.toISOString(),
        activated: user.activatedAt?.toISOString() ?? null,
        approved: user.isApproved,
        accountStatus: user.accountStatus,
        schoolVerification: current?.status ?? null,
        source: teacherApp ? 'TEACHER_APPLICATION' : coachApp ? 'COACH_APPLICATION' : null,
      },
      events: rows.map((r) => ({
        id: r.id,
        at: r.createdAt.toISOString(),
        action: r.action,
        label: TIMELINE_LABELS[r.action] ?? r.action,
        // The person themselves, an administrator, or nobody signed in (a public registration / application).
        actor: r.actorId === userId ? 'SELF' : r.actorRole === 'ANONYMOUS' || !r.actorRole ? 'APPLICANT' : r.actorRole,
        actorUsername: r.actorId === userId ? null : r.actorUsername ?? null,
        details: safeDetails(r.action, r.metadata),
      })),
    };
  }
}
