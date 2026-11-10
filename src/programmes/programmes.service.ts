/**
 * Programmes (plan §7, §10.1; P1-10). A programme is an existing `Discipline`
 * row; nothing here creates or edits programmes.
 *
 *  - Heads: Head Coaches heading a programme = their ACTIVE membership in it.
 *    Set only by Administrators (programmes.manageHeads), never by a Head Coach.
 *  - Members: Students and Coaches. Administrators add/end any; a Head Coach
 *    (programmes.manageMembers, own programmes) adds/ends STUDENT memberships
 *    only — Coaches join through an Administrator (or, later, an invitation
 *    that an Administrator approves).
 *
 * Head Coach visibility (HC-A, plan §7.2): only programmes they head; other
 * programmes → 404; ADMIN, SUPER_ADMIN, TEACHER and other HEAD_COACH accounts
 * are never returned to them. No contact details, grades, marks or feedback
 * are ever returned here (D7).
 *
 * Every change is audited in the same transaction.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import { scopeForbidden, AccessService } from '../common/access/access.service.js';
import { isAdmin, isHeadCoach, unsupportedRole } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CURRENT_CLAIM_SELECT, withVerification } from '../schools/affiliations/school-verification.js';
import { AddProgrammeMemberDto, ListProgrammeMembersDto, MEMBER_ROLES, SetProgrammeHeadsDto } from './dto/programme.dto.js';

const PROGRAMME_SELECT = { id: true, code: true, name: true, description: true, isActive: true, sortOrder: true } as const;

/** What a member row shows: no e-mail, phone, grades, marks or feedback (D7). The school carries
 *  `verification` (VERIFIED / UNVERIFIED): an unverified school is never presented as fact. */
const MEMBER_SELECT = {
  source: true, isActive: true, createdAt: true, endedAt: true,
  user: {
    select: {
      id: true, username: true, firstName: true, lastName: true, role: true, gradeLevel: true, isActive: true,
      division: { select: { id: true, code: true, name: true } },
      school:   { select: { id: true, name: true } },
      schoolAffiliations: CURRENT_CLAIM_SELECT,
    },
  },
} as const;

const HEAD_SELECT = {
  createdAt: true,
  user: { select: { id: true, username: true, firstName: true, lastName: true, email: true, isActive: true } },
} as const;

/** Namespace of the per-programme advisory lock taken while replacing the heads. */
const HEADS_LOCK_NAMESPACE = 4210;

type MemberRow = Prisma.ProgrammeMembershipGetPayload<{ select: typeof MEMBER_SELECT }>;
const memberView = ({ user: { schoolAffiliations, ...user }, ...m }: MemberRow) => ({
  ...user,
  school: withVerification(user.school, schoolAffiliations),
  membership: { source: m.source, isActive: m.isActive, createdAt: m.createdAt, endedAt: m.endedAt },
});

@Injectable()
export class ProgrammesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit:  AuditService,
  ) {}

  /** GET /programmes — the existing programmes (read-only). */
  list() {
    return this.prisma.discipline.findMany({ select: PROGRAMME_SELECT, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  }

  // ─── Heads (Administrators only) ────────────────────────────────────────────

  async heads(disciplineId: string) {
    await this.requireProgramme(disciplineId);
    const rows = await this.prisma.programmeMembership.findMany({
      where: { disciplineId, isActive: true, user: { role: 'HEAD_COACH' } },
      select: HEAD_SELECT, orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ ...r.user, since: r.createdAt }));
  }

  /** Replace the programme's heads with exactly these Head Coaches (added / ended, audited once). */
  async setHeads(disciplineId: string, dto: SetProgrammeHeadsDto, actor: AuthUser) {
    await this.requireProgramme(disciplineId);
    const users = await this.prisma.user.findMany({ where: { id: { in: dto.userIds } }, select: { id: true, role: true } });
    const notHeadCoach = dto.userIds.filter((id) => users.find((u) => u.id === id)?.role !== 'HEAD_COACH');
    if (notHeadCoach.length) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'NOT_A_HEAD_COACH', 'Only users with the HEAD_COACH role can head a programme.', { userIds: notHeadCoach });
    }

    await this.prisma.$transaction(async (tx) => {
      // Serialise concurrent replacements of the same programme's heads.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${HEADS_LOCK_NAMESPACE}::int, hashtext(${disciplineId}))::text`;
      const current = (await tx.programmeMembership.findMany({
        where: { disciplineId, isActive: true, user: { role: 'HEAD_COACH' } }, select: { userId: true },
      })).map((r) => r.userId);
      const added = dto.userIds.filter((id) => !current.includes(id));
      const removed = current.filter((id) => !dto.userIds.includes(id));
      const now = new Date();
      for (const userId of added) {
        await tx.programmeMembership.upsert({
          where:  { userId_disciplineId: { userId, disciplineId } },
          create: { userId, disciplineId, source: 'MANUAL', addedById: actor.id },
          update: { isActive: true, endedAt: null, endedById: null, addedById: actor.id, source: 'MANUAL' },
        });
      }
      if (removed.length) {
        await tx.programmeMembership.updateMany({
          where: { disciplineId, userId: { in: removed }, isActive: true },
          data:  { isActive: false, endedAt: now, endedById: actor.id },
        });
      }
      if (added.length || removed.length) {
        await this.audit.log({
          actorId: actor.id, actorRole: actor.role, action: 'PROGRAMME_HEADS_SET', entity: 'Discipline', entityId: disciplineId,
          metadata: { added, removed, previous: current, next: dto.userIds },
        }, tx);
      }
    });
    return this.heads(disciplineId);
  }

  // ─── Members (Administrators; Head Coaches in their own programmes) ─────────

  async members(disciplineId: string, q: ListProgrammeMembersDto, caller: AuthUser) {
    await this.requireProgramme(disciplineId);
    await this.access.assertProgrammeInScope(caller, disciplineId);
    const isActive = q.isActive ?? true;
    // Head Coaches see current members only: a former member is no longer in their programme.
    if (isHeadCoach(caller) && !isActive) throw scopeForbidden('Head Coaches see current programme members only.');
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.ProgrammeMembershipWhereInput = {
      disciplineId, isActive,
      user: { role: { in: q.role ? [q.role] : [...MEMBER_ROLES] } },
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.programmeMembership.findMany({
        where, select: MEMBER_SELECT, skip, take,
        orderBy: [{ user: { role: 'asc' } }, { user: { lastName: 'asc' } }, { user: { firstName: 'asc' } }, { userId: 'asc' }],
      }),
      this.prisma.programmeMembership.count({ where }),
    ]);
    return paginated(rows.map(memberView), total, page, limit);
  }

  async addMember(disciplineId: string, dto: AddProgrammeMemberDto, caller: AuthUser) {
    await this.requireProgramme(disciplineId);
    await this.access.assertProgrammeInScope(caller, disciplineId);
    const target = await this.prisma.user.findUnique({ where: { id: dto.userId }, select: { id: true, role: true } });
    this.assertMayChangeMembership(caller, target);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.programmeMembership.findUnique({
        where: { userId_disciplineId: { userId: dto.userId, disciplineId } }, select: { id: true, isActive: true },
      });
      if (existing?.isActive) throw alreadyMember();
      let id: string;
      if (existing) {
        // Re-activate the one row per (user, programme) — conditional, so a concurrent add cannot double-count.
        const { count } = await tx.programmeMembership.updateMany({
          where: { id: existing.id, isActive: false },
          data:  { isActive: true, endedAt: null, endedById: null, addedById: caller.id, source: 'MANUAL' },
        });
        if (count === 0) throw alreadyMember();
        id = existing.id;
      } else {
        id = (await tx.programmeMembership.create({
          data: { userId: dto.userId, disciplineId, source: 'MANUAL', addedById: caller.id }, select: { id: true },
        }).catch((e: unknown) => { throw isUniqueViolation(e) ? alreadyMember() : e; })).id;
      }
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'PROGRAMME_MEMBER_ADD', entity: 'ProgrammeMembership', entityId: id,
        metadata: { disciplineId, userId: dto.userId, role: target!.role, reactivated: !!existing },
      }, tx);
      return memberView(await tx.programmeMembership.findUniqueOrThrow({ where: { id }, select: MEMBER_SELECT }));
    });
  }

  async endMember(disciplineId: string, userId: string, caller: AuthUser) {
    await this.requireProgramme(disciplineId);
    await this.access.assertProgrammeInScope(caller, disciplineId);
    const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true } });
    this.assertMayChangeMembership(caller, target);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.programmeMembership.findUnique({
        where: { userId_disciplineId: { userId, disciplineId } }, select: { id: true },
      });
      if (!existing) throw new NotFoundException('Membership not found.');
      // Atomic: only an active membership is ended; a concurrent end gets 409.
      const { count } = await tx.programmeMembership.updateMany({
        where: { id: existing.id, isActive: true },
        data:  { isActive: false, endedAt: new Date(), endedById: caller.id },
      });
      if (count === 0) throw new AppError(HttpStatus.CONFLICT, 'MEMBERSHIP_ENDED', 'This membership has already ended.');
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'PROGRAMME_MEMBER_END', entity: 'ProgrammeMembership', entityId: existing.id,
        metadata: { disciplineId, userId, role: target!.role },
      }, tx);
      return memberView(await tx.programmeMembership.findUniqueOrThrow({ where: { id: existing.id }, select: MEMBER_SELECT }));
    });
  }

  /**
   * Who may change whose membership:
   *  - Administrators: Students and Coaches (Head Coaches go through the heads endpoint);
   *  - Head Coaches: Students only. Coaches → 403 SCOPE_FORBIDDEN; anyone else is
   *    not revealed to them (404).
   */
  private assertMayChangeMembership(caller: AuthUser, target: { id: string; role: string } | null) {
    if (isAdmin(caller)) {
      if (!target) throw new NotFoundException('User not found.');
      if (target.role === 'STUDENT' || target.role === 'MENTOR') return;
      throw new AppError(HttpStatus.BAD_REQUEST, 'ROLE_NOT_MEMBER', 'Only students and coaches are programme members; Head Coaches are set as heads.', { role: target.role });
    }
    if (isHeadCoach(caller)) {
      if (!target || (target.role !== 'STUDENT' && target.role !== 'MENTOR')) throw new NotFoundException('User not found.');
      if (target.role === 'STUDENT') return;
      throw scopeForbidden('Coaches join a programme through an Administrator.', { role: target.role });
    }
    throw unsupportedRole();
  }

  private async requireProgramme(disciplineId: string) {
    const found = await this.prisma.discipline.findUnique({ where: { id: disciplineId }, select: { id: true } });
    if (!found) throw new NotFoundException('Programme not found.');
  }
}

const alreadyMember = () => new AppError(HttpStatus.CONFLICT, 'ALREADY_MEMBER', 'This user is already an active member of the programme.');
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === 'P2002';
