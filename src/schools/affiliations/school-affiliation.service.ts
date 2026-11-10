/**
 * Student–school affiliation (school administration PR A; owner-approved 2026-11-10).
 *
 * The only writer of StudentSchoolAffiliation. A student has at most ONE current claim
 * (supersededAt NULL). Choosing a school, account approval or e-mail verification never
 * proves membership: only an Administrator (schools.manage) verifies, rejects or revokes.
 *
 *   claim()       inside the caller's transaction, under a per-student advisory lock:
 *                 supersedes the current claim (SCHOOL_CHANGE / NEW_CLAIM) and creates a
 *                 PENDING one; both audited in that transaction.
 *   supersede()   ends the current claim without a new one (ROLE_CHANGE).
 *   beginUserChange()
 *                 in a user edit, BEFORE User.schoolId or the role changes: ends a current
 *                 claim that will no longer match and returns the claim to create once the
 *                 User row is written; decided from the locked current claim, so concurrent
 *                 edits agree.
 *   verify / reject / revoke
 *                 one conditional update each (current, expected status) + its audit row,
 *                 atomically; a stale or concurrent decision gets 409.
 *
 * Teacher access requires a current VERIFIED claim for the student's school
 * (AccessService.schoolStudentsFilter).
 *
 * The database enforces both invariants after every statement (M10): at most one current claim per
 * student, and the current claim's school is User.schoolId.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import type { AuthUser } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { pageArgs, paginated } from '../../common/pagination.js';
import type { Prisma, SchoolAffiliationSource, SchoolAffiliationStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ListAffiliationsDto } from './school-affiliation.dto.js';

/** Namespace of the per-student advisory lock taken while changing the current claim. */
const AFFILIATION_LOCK_NAMESPACE = 4212;

export type SupersedeReason = 'SCHOOL_CHANGE' | 'ROLE_CHANGE' | 'NEW_CLAIM';
/** Who changes a claim — the same shape as an audit entry's actor. */
export interface AffiliationActor { actorId: string | null; actorRole: string | null }
export interface ClaimInput {
  studentId: string;
  schoolId:  string | null;
  claimed?:  { name?: string | null; country?: string | null; province?: string | null; district?: string | null; sector?: string | null };
  source:    SchoolAffiliationSource;
  actor:     AffiliationActor;
  /** Why an existing current claim is superseded. */
  reason:    Exclude<SupersedeReason, 'ROLE_CHANGE'>;
}

const ADMIN_SELECT = {
  id: true, status: true, source: true, createdAt: true,
  claimedName: true, claimedCountry: true, claimedProvince: true, claimedDistrict: true, claimedSector: true,
  decidedAt: true, decisionReason: true, revokedAt: true, revokeReason: true,
  supersededAt: true, supersedeReason: true,
  student:      { select: { id: true, username: true, firstName: true, lastName: true, gradeLevel: true, division: { select: { id: true, code: true, name: true } } } },
  school:       { select: { id: true, code: true, name: true, location: true } },
  createdBy:    { select: { id: true, username: true } },
  decidedBy:    { select: { id: true, username: true } },
  revokedBy:    { select: { id: true, username: true } },
  supersededBy: { select: { id: true, username: true } },
} as const;

@Injectable()
export class SchoolAffiliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ─── Claims (inside the caller's transaction) ───────────────────────────────

  /** Supersede the current claim (if any) and create a PENDING one. Returns the new claim's id. */
  async claim(tx: Prisma.TransactionClient, input: ClaimInput): Promise<string> {
    await this.lock(tx, input.studentId);
    await this.supersedeLocked(tx, input.studentId, input.reason, input.actor);
    const c = input.claimed ?? {};
    const created = await tx.studentSchoolAffiliation.create({
      data: {
        studentId: input.studentId, schoolId: input.schoolId, status: 'PENDING', source: input.source, createdById: input.actor.actorId,
        claimedName: c.name ?? null, claimedCountry: c.country ?? null,
        claimedProvince: c.province ?? null, claimedDistrict: c.district ?? null, claimedSector: c.sector ?? null,
      },
      select: { id: true },
    });
    await this.audit.log({
      ...input.actor, action: 'SCHOOL_AFFILIATION_CREATED',
      entity: 'StudentSchoolAffiliation', entityId: created.id,
      metadata: {
        studentId: input.studentId, schoolId: input.schoolId, source: input.source, status: 'PENDING',
        ...(input.schoolId === null && { claimedName: c.name ?? null, claimedCountry: c.country ?? null }),
      },
    }, tx);
    return created.id;
  }

  /** End the current claim without a new one (e.g. the user is no longer a STUDENT). */
  async supersede(tx: Prisma.TransactionClient, studentId: string, reason: SupersedeReason, actor: AffiliationActor): Promise<void> {
    await this.lock(tx, studentId);
    await this.supersedeLocked(tx, studentId, reason, actor);
  }

  /**
   * Step 1 of a user edit, inside its transaction, after the caller has locked the User row and
   * BEFORE it writes the new role or school (M10 checks every statement, so the claim that will
   * no longer match must end first): a non-student keeps no current claim; a student's current
   * claim must be for `user.schoolId`. When it already is (re-sending the same school), nothing
   * changes and its status — VERIFIED included — is kept.
   * Returns the claim to create (`claim()`) once the User row is written, or null.
   */
  async beginUserChange(
    tx: Prisma.TransactionClient,
    user: { id: string; isStudent: boolean; schoolId: string | null; becameStudent: boolean },
    actor: AffiliationActor,
  ): Promise<ClaimInput | null> {
    await this.lock(tx, user.id);
    if (!user.isStudent) {
      await this.supersedeLocked(tx, user.id, 'ROLE_CHANGE', actor);
      return null;
    }
    const current = await tx.studentSchoolAffiliation.findFirst({ where: { studentId: user.id, supersededAt: null }, select: { schoolId: true } });
    if ((current?.schoolId ?? null) === user.schoolId) return null;   // the same school (or none, and no claim)
    const reason = user.becameStudent ? 'NEW_CLAIM' : 'SCHOOL_CHANGE';
    await this.supersedeLocked(tx, user.id, reason, actor);
    return user.schoolId ? { studentId: user.id, schoolId: user.schoolId, source: 'ADMIN', reason, actor } : null;
  }

  private async lock(tx: Prisma.TransactionClient, studentId: string) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${AFFILIATION_LOCK_NAMESPACE}::int, hashtext(${studentId}))::text`;
  }

  private async supersedeLocked(tx: Prisma.TransactionClient, studentId: string, reason: SupersedeReason, actor: AffiliationActor) {
    // Row-locked read: Administrator decisions do not take the per-student lock, so a plain read
    // could return a status a concurrent decision is changing. FOR UPDATE waits for that decision
    // and returns the committed status; a decision arriving later waits for this transaction and,
    // the claim no longer being current, gets 409. The audit's previous status is therefore exact.
    const rows = await tx.$queryRaw<Array<{ id: string; status: SchoolAffiliationStatus; schoolId: string | null }>>`
      SELECT "id", "status"::text AS "status", "schoolId" FROM "StudentSchoolAffiliation"
       WHERE "studentId" = ${studentId} AND "supersededAt" IS NULL
         FOR UPDATE`;
    for (const current of rows) {
      await tx.studentSchoolAffiliation.update({
        where: { id: current.id },
        data:  { supersededAt: new Date(), supersededById: actor.actorId, supersedeReason: reason },
      });
      await this.audit.log({
        ...actor, action: 'SCHOOL_AFFILIATION_SUPERSEDED',
        entity: 'StudentSchoolAffiliation', entityId: current.id,
        metadata: { studentId, schoolId: current.schoolId, reason, previous: { status: current.status, current: true }, next: { current: false } },
      }, tx);
    }
  }

  // ─── Administrator decisions (each atomic with its audit row) ───────────────

  verify(id: string, actor: AuthUser, note?: string) {
    return this.decide(id, actor, 'PENDING', 'VERIFIED', 'SCHOOL_AFFILIATION_VERIFIED',
      { decidedAt: new Date(), decidedById: actor.id, decisionReason: note ?? null }, { requireSchool: true, reason: note ?? null });
  }

  reject(id: string, actor: AuthUser, reason: string) {
    return this.decide(id, actor, 'PENDING', 'REJECTED', 'SCHOOL_AFFILIATION_REJECTED',
      { decidedAt: new Date(), decidedById: actor.id, decisionReason: reason }, { reason });
  }

  revoke(id: string, actor: AuthUser, reason: string) {
    return this.decide(id, actor, 'VERIFIED', 'REVOKED', 'SCHOOL_AFFILIATION_REVOKED',
      { revokedAt: new Date(), revokedById: actor.id, revokeReason: reason }, { reason });
  }

  private async decide(
    id: string, actor: AuthUser, from: SchoolAffiliationStatus, to: SchoolAffiliationStatus, action: string,
    data: Prisma.StudentSchoolAffiliationUncheckedUpdateManyInput, opts: { requireSchool?: boolean; reason: string | null },
  ) {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.studentSchoolAffiliation.findUnique({
        where: { id }, select: { id: true, studentId: true, schoolId: true, status: true, supersededAt: true },
      });
      if (!row) throw new NotFoundException('Affiliation not found.');
      if (row.supersededAt) throw conflict('AFFILIATION_SUPERSEDED', 'This claim has been replaced by a newer one.');
      if (row.status !== from) throw conflict('AFFILIATION_STATUS_CONFLICT', `Only a ${from} claim can become ${to}.`, { status: row.status });
      if (opts.requireSchool && !row.schoolId) {
        throw conflict('AFFILIATION_SCHOOL_REQUIRED', 'The claim has no school yet; resolve the school before verifying membership.');
      }
      // Atomic: only the still-current claim in the expected status changes; a concurrent
      // decision or a new claim makes this update nothing → 409, and nothing is audited.
      const { count } = await tx.studentSchoolAffiliation.updateMany({
        where: { id, status: from, supersededAt: null, ...(opts.requireSchool && { schoolId: { not: null } }) },
        data:  { ...data, status: to },
      });
      if (count === 0) throw conflict('AFFILIATION_STATUS_CONFLICT', 'The claim changed meanwhile; refresh and try again.');
      await this.audit.log({
        actorId: actor.id, actorRole: actor.role, action, entity: 'StudentSchoolAffiliation', entityId: id,
        metadata: { studentId: row.studentId, schoolId: row.schoolId, previous: { status: from }, next: { status: to }, reason: opts.reason },
      }, tx);
      return tx.studentSchoolAffiliation.findUniqueOrThrow({ where: { id }, select: ADMIN_SELECT });
    });
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  async list(q: ListAffiliationsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.StudentSchoolAffiliationWhereInput = {
      ...((q.current ?? true) && { supersededAt: null }),
      ...(q.status    && { status: q.status }),
      ...(q.schoolId  && { schoolId: q.schoolId }),
      ...(q.studentId && { studentId: q.studentId }),
      ...(q.country   && { OR: [{ claimedCountry: q.country }, ...(q.country === 'RW' ? [{ schoolId: { not: null } }] : [])] }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.studentSchoolAffiliation.findMany({ where, select: ADMIN_SELECT, skip, take, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.studentSchoolAffiliation.count({ where }),
    ]);
    return paginated(rows, total, page, limit);
  }

  async get(id: string) {
    const row = await this.prisma.studentSchoolAffiliation.findUnique({ where: { id }, select: ADMIN_SELECT });
    if (!row) throw new NotFoundException('Affiliation not found.');
    return row;
  }

  /** A student's claims, newest first. */
  async history(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found.');
    return this.prisma.studentSchoolAffiliation.findMany({ where: { studentId: userId }, select: ADMIN_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  }

  /** The student's own current claim: status, school or entered name, and the reason of a rejection or revocation — never who decided. */
  async mine(user: AuthUser) {
    const row = await this.prisma.studentSchoolAffiliation.findFirst({
      where: { studentId: user.id, supersededAt: null },
      select: {
        status: true, createdAt: true, claimedName: true, claimedCountry: true,
        decidedAt: true, decisionReason: true, revokedAt: true, revokeReason: true,
        school: { select: { id: true, code: true, name: true, location: true } },
      },
    });
    if (!row) return { current: null };
    return {
      current: {
        status: row.status, school: row.school, claimedName: row.claimedName, claimedCountry: row.claimedCountry, submittedAt: row.createdAt,
        decidedAt: row.status === 'REVOKED' ? row.revokedAt : row.decidedAt,
        reason:    row.status === 'REJECTED' ? row.decisionReason : row.status === 'REVOKED' ? row.revokeReason : null,
      },
    };
  }
}

function conflict(code: string, message: string, details?: unknown) {
  return new AppError(HttpStatus.CONFLICT, code, message, details);
}
