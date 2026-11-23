/**
 * Coaches across their programmes (owner 2026-11-23).
 *
 * By default every Coach, in every programme they belong to and at every level, may
 *   STUDENTS  see the programme's students (GET /coach/students; the student overview),
 *   COURSES   open and manage every course of the programme (AccessService.courseScopes),
 *   MARKING   mark the subject's tests (marker-reach.ts; marking stays blind and assigned),
 *   RESULTS   see the subject's published results (GET /coach/test-results).
 * An Administrator (users.manageCoaches, every programme) or a Head Coach of the programme takes any of them away from one
 * coach in that programme, with a reason, and gives it back (CoachProgrammeRestriction; audited; history kept).
 * Homework grading distribution keeps using the explicit course × level assignments.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { AccessService, scopeForbidden } from '../common/access/access.service.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { CoachCapability, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CoachStudentsQueryDto, SetCoachAccessDto } from './coach-access.dto.js';

export const COACH_CAPABILITIES: readonly CoachCapability[] = ['STUDENTS', 'COURSES', 'MARKING', 'RESULTS'];
export const CAPABILITY_LABELS: Readonly<Record<CoachCapability, string>> = {
  STUDENTS: 'See the programme’s students',
  COURSES: 'Open and manage every course of the programme',
  MARKING: 'Mark the programme’s tests',
  RESULTS: 'See the programme’s published test results',
};

const PERSON = { select: { id: true, firstName: true, lastName: true } } as const;

@Injectable()
export class CoachAccessService {
  constructor(private readonly prisma: PrismaService, private readonly access: AccessService, private readonly audit: AuditService) {}

  // ── The coach's Students page ─────────────────────────────────────────────────

  /** The students of my programmes (STUDENTS not taken away), every level; ACTIVE accounts; never contact details. */
  async students(user: AuthUser, q: CoachStudentsQueryDto) {
    if (user.role !== 'MENTOR') throw new AppError(HttpStatus.FORBIDDEN, 'ROLE_NOT_SUPPORTED', 'This page is for coaches.');
    const programmes = await this.access.coachProgrammes(user, 'STUDENTS');
    if (q.programmeId && !programmes.includes(q.programmeId)) throw new NotFoundException('Programme not found.');
    const inProgrammes = q.programmeId ? [q.programmeId] : programmes;
    const contains = q.q ? { contains: q.q, mode: 'insensitive' as const } : undefined;
    const where: Prisma.UserWhereInput = {
      role: 'STUDENT', accountStatus: 'ACTIVE',
      programmeMemberships: { some: { disciplineId: { in: inProgrammes }, isActive: true } },
      ...(q.division && { division: { code: q.division } }),
      ...(contains && { OR: [{ firstName: contains }, { lastName: contains }, { username: contains }] }),
    };
    const { page, limit, skip, take } = pageArgs(q);
    const [rows, total, programmeRows] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: {
          id: true, firstName: true, lastName: true, username: true, avatarUrl: true, gradeLevel: true,
          division: { select: { code: true, name: true } }, school: { select: { id: true, name: true } },
          olympiadInterests: true, olympiadInterestOther: true,
          programmeMemberships: { where: { isActive: true, disciplineId: { in: programmes } }, select: { discipline: { select: { id: true, name: true } } } },
        },
      }),
      this.prisma.user.count({ where }),
      this.prisma.discipline.findMany({ where: { id: { in: programmes } }, orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, name: true } }),
    ]);
    return {
      programmes: programmeRows,
      ...paginated(rows.map(({ programmeMemberships, ...s }) => ({ ...s, programmes: programmeMemberships.map((m) => m.discipline) })), total, page, limit),
    };
  }

  // ── Administrators and Head Coaches: a coach's programme access ─────────────────

  /** The programmes the caller manages for this coach: every one (Administrator) or the ones they head (Head Coach). */
  private async managed(actor: AuthUser, coachId: string) {
    const coach = await this.prisma.user.findUnique({
      where: { id: coachId },
      select: { id: true, role: true, firstName: true, lastName: true, programmeMemberships: { where: { isActive: true }, select: { disciplineId: true } } },
    });
    if (!coach || coach.role !== 'MENTOR') throw new NotFoundException('Coach not found.');
    const scope = await this.access.programmeScope(actor);
    const memberOf = coach.programmeMemberships.map((m) => m.disciplineId);
    const managed = scope === 'all' ? memberOf : memberOf.filter((d) => scope.includes(d));
    // A Head Coach sees a coach only through a programme they head.
    if (scope !== 'all' && !managed.length) throw new NotFoundException('Coach not found.');
    return { coach, managed };
  }

  /** Per programme the caller manages: each capability, allowed or taken away (why, by whom, when); and the history. */
  async get(coachId: string, actor: AuthUser) {
    const { coach, managed } = await this.managed(actor, coachId);
    const [disciplines, rows] = await Promise.all([
      this.prisma.discipline.findMany({ where: { id: { in: managed } }, orderBy: { sortOrder: 'asc' }, select: { id: true, code: true, name: true } }),
      this.prisma.coachProgrammeRestriction.findMany({
        where: { coachId, disciplineId: { in: managed } }, orderBy: { createdAt: 'desc' },
        select: { id: true, disciplineId: true, capability: true, reason: true, createdAt: true, createdBy: PERSON, liftedAt: true, liftedBy: PERSON, liftReason: true },
      }),
    ]);
    return {
      coach: { id: coach.id, firstName: coach.firstName, lastName: coach.lastName },
      capabilities: COACH_CAPABILITIES.map((c) => ({ key: c, label: CAPABILITY_LABELS[c] })),
      programmes: disciplines.map((d) => ({
        programme: d,
        access: COACH_CAPABILITIES.map((c) => {
          const active = rows.find((r) => r.disciplineId === d.id && r.capability === c && !r.liftedAt);
          return { capability: c, allowed: !active, removed: active ? { id: active.id, reason: active.reason, at: active.createdAt, by: active.createdBy } : null };
        }),
      })),
      history: rows,
    };
  }

  /**
   * Take a capability away (allowed false; reason 3–500 characters) or give it back (allowed true; reason optional) for
   * one programme. Idempotent; audited when it changes. 400 NOT_A_PROGRAMME_MEMBER when the coach is not in it.
   */
  async set(coachId: string, dto: SetCoachAccessDto, actor: AuthUser) {
    const { managed } = await this.managed(actor, coachId);
    const scope = await this.access.programmeScope(actor);
    if (scope !== 'all' && !scope.includes(dto.programmeId)) {
      throw scopeForbidden('A Head Coach changes a coach’s access only in the programmes they head.', { programmeId: dto.programmeId });
    }
    if (!managed.includes(dto.programmeId)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_PROGRAMME_MEMBER', 'This coach is not a member of that programme. Add them to the programme first.');
    }
    const reason = dto.reason?.trim();
    if (!dto.allowed && (!reason || reason.length < 3)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED', 'Give a reason (3 to 500 characters) for taking this away.');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`coach-access:${coachId}:${dto.programmeId}:${dto.capability}`}))`;
      const active = await tx.coachProgrammeRestriction.findFirst({
        where: { coachId, disciplineId: dto.programmeId, capability: dto.capability, liftedAt: null }, select: { id: true },
      });
      const meta = { coachId, programmeId: dto.programmeId, capability: dto.capability, ...(reason && { reason }) };
      if (!dto.allowed && !active) {
        const row = await tx.coachProgrammeRestriction.create({
          data: { coachId, disciplineId: dto.programmeId, capability: dto.capability, reason: reason!, createdById: actor.id }, select: { id: true },
        });
        await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: 'COACH_PROGRAMME_ACCESS_REMOVED', entity: 'User', entityId: coachId, metadata: { ...meta, restrictionId: row.id } }, tx);
      } else if (dto.allowed && active) {
        await tx.coachProgrammeRestriction.update({ where: { id: active.id }, data: { liftedAt: new Date(), liftedById: actor.id, liftReason: reason ?? null } });
        await this.audit.log({ actorId: actor.id, actorRole: actor.role, action: 'COACH_PROGRAMME_ACCESS_RESTORED', entity: 'User', entityId: coachId, metadata: { ...meta, restrictionId: active.id } }, tx);
      }
    });
    return this.get(coachId, actor);
  }
}
