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
 *   request()     (PR C) a student's own new claim — by school code, "not listed" (name + official
 *                 place) or another country; rate-limited and cooled down (school-claim-rules.ts).
 *   match()       (PR C) an Administrator links a name-only claim to an existing school; the new
 *                 claim stays PENDING (verifying is a separate action).
 *   reopen()      (PR C) an Administrator reopens the current REJECTED / REVOKED claim as PENDING.
 *
 * Every path that changes a student's claim takes, in this order: the student's User row
 * (FOR UPDATE), the per-student advisory lock, the claim row (FOR UPDATE), then the school
 * (FOR SHARE). It ends the old claim, then writes User.schoolId and the current-year enrolment
 * together (enrollInCurrentYear), then creates the new claim — so M10 holds after every
 * statement and the enrolment never diverges from User.schoolId.
 *
 * Teacher access requires a current VERIFIED claim for the student's school
 * (AccessService.schoolStudentsFilter).
 *
 * The database enforces both invariants after every statement (M10): at most one current claim per
 * student, and the current claim's school is User.schoolId.
 *
 * Inactive schools (PR B): a new claim for a school, and its verification, lock the school row
 * (FOR SHARE, school-usage.ts) and are refused when it is inactive (409 SCHOOL_INACTIVE).
 * Rejecting and revoking stay possible. Lock order everywhere: the student's claim row, then the
 * school — so a claim, a verification and a deactivation can never deadlock.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AcademicYearsService } from '../../academic-years/academic-years.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { AuthUser } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { pageArgs, paginated } from '../../common/pagination.js';
import { Prisma, type GradeLevel, type SchoolAffiliationSource, type SchoolAffiliationStatus } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { assertDirectoryPlace, SQL_NAME_KEY, uniqueOfficialSchoolInPlace } from '../school-directory.js';
import { schoolKey } from '../school-key.js';
import { resolveSchoolReference } from '../school-reference.js';
import { RWANDA } from '../school-rules.js';
import { lockSchoolsForUse, schoolInactive } from '../school-usage.js';
import {
  classifyClaimRequest, cooldownUntil, limitRetryAfter, sameSchool, type ClaimIdentity, type ClaimRequest,
} from './school-claim-rules.js';
import { ListAffiliationsDto, MatchAffiliationDto, StudentClaimDto } from './school-affiliation.dto.js';

/** Namespace of the per-student advisory lock taken while changing the current claim. */
const AFFILIATION_LOCK_NAMESPACE = 4212;

export type SupersedeReason = 'SCHOOL_CHANGE' | 'ROLE_CHANGE' | 'NEW_CLAIM' | 'RESOLVED' | 'REOPENED';
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
    private readonly prisma:        PrismaService,
    private readonly audit:         AuditService,
    private readonly academicYears: AcademicYearsService,
  ) {}

  // ─── Claims (inside the caller's transaction) ───────────────────────────────

  /** Supersede the current claim (if any) and create a PENDING one. Returns the new claim's id. */
  async claim(tx: Prisma.TransactionClient, input: ClaimInput): Promise<string> {
    await this.lock(tx, input.studentId);
    await this.supersedeLocked(tx, input.studentId, input.reason, input.actor);
    // A claim for a school needs an ACTIVE school, locked until this transaction commits.
    if (input.schoolId) await lockSchoolsForUse(tx, [input.schoolId]);
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
      // The claim row first (FOR UPDATE: a concurrent decision or supersession waits here), then
      // — for a verification — the school: the same order as claim() takes them.
      const [row] = await tx.$queryRaw<Array<{ id: string; studentId: string; schoolId: string | null; status: SchoolAffiliationStatus; supersededAt: Date | null }>>`
        SELECT "id", "studentId", "schoolId", "status"::text AS "status", "supersededAt"
          FROM "StudentSchoolAffiliation" WHERE "id" = ${id} FOR UPDATE`;
      if (!row) throw new NotFoundException('Affiliation not found.');
      if (row.supersededAt) throw conflict('AFFILIATION_SUPERSEDED', 'This claim has been replaced by a newer one.');
      if (row.status !== from) throw conflict('AFFILIATION_STATUS_CONFLICT', `Only a ${from} claim can become ${to}.`, { status: row.status });
      if (opts.requireSchool && !row.schoolId) {
        throw conflict('AFFILIATION_SCHOOL_REQUIRED', 'The claim has no school yet; resolve the school before verifying membership.');
      }
      // Verifying membership of an inactive school is refused (rejecting / revoking is not).
      if (opts.requireSchool) await lockSchoolsForUse(tx, [row.schoolId!]);
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

  // ─── PR C: the student's own claim ──────────────────────────────────────────

  /**
   * POST /me/school-affiliation. Always a NEW PENDING claim (never verified). Refused: the same
   * school already pending (409 CLAIM_ALREADY_PENDING) or verified (409 ALREADY_VERIFIED); a 4th
   * student request within 24 hours (429 CLAIM_LIMIT_REACHED); within 7 days of a rejection or
   * revocation for the SAME school (429 CLAIM_COOLDOWN); an inactive school (409 SCHOOL_INACTIVE).
   * The limit and cooldown are checked under the student's locks, so concurrent requests are
   * counted one after another and cannot exceed them.
   */
  async request(user: AuthUser, dto: StudentClaimDto) {
    const req = classifyClaimRequest(dto);
    const actor: AffiliationActor = { actorId: user.id, actorRole: user.role };
    await this.prisma.$transaction(async (tx) => {
      const student = await this.lockStudent(tx, user.id);
      if (student.role !== 'STUDENT') {
        throw new AppError(HttpStatus.FORBIDDEN, 'ROLE_NOT_SUPPORTED', 'Only students can claim a school.');
      }
      const target = await this.requestTarget(tx, req);
      const claims = await tx.studentSchoolAffiliation.findMany({ where: { studentId: user.id }, select: HISTORY_SELECT });
      const now = new Date();

      const current = claims.find((c) => c.supersededAt === null);
      if (current && sameSchool(identityOf(current), target.identity)) {
        if (current.status === 'PENDING') throw conflict('CLAIM_ALREADY_PENDING', 'You already have a pending claim for this school.');
        if (current.status === 'VERIFIED') throw conflict('ALREADY_VERIFIED', 'Your membership of this school is already verified.');
      }
      const limit = limitRetryAfter(
        claims.filter((c) => c.source === 'STUDENT_REQUEST' && c.createdById === user.id).map((c) => c.createdAt), now);
      if (limit) {
        throw tooMany('CLAIM_LIMIT_REACHED', 'You can make at most 3 school requests in 24 hours.', { retryAfter: limit.toISOString() });
      }
      const decisions = claims
        .filter((c) => sameSchool(identityOf(c), target.identity))
        .flatMap((c) => (c.status === 'REJECTED' && c.decidedAt ? [c.decidedAt] : c.status === 'REVOKED' && c.revokedAt ? [c.revokedAt] : []));
      const cooldown = cooldownUntil(decisions, now);
      if (cooldown) {
        throw tooMany('CLAIM_COOLDOWN', 'This school was rejected or revoked recently; you can claim it again after the cooldown.',
          { retryAfter: cooldown.toISOString(), schoolId: target.identity.schoolId, schoolName: target.identity.name });
      }

      await this.supersedeLocked(tx, user.id, 'NEW_CLAIM', actor);
      await this.academicYears.enrollInCurrentYear(tx, user.id, student.gradeLevel!, target.identity.schoolId);
      await this.claim(tx, {
        studentId: user.id, schoolId: target.identity.schoolId, claimed: target.claimed, source: 'STUDENT_REQUEST', reason: 'NEW_CLAIM', actor,
      });
    });
    return this.mine(user);
  }

  /** The school a request names: by code (active, Rwandan), "not listed" (official place; an exact unique official match is linked), or another country (never matched). */
  private async requestTarget(tx: Prisma.TransactionClient, req: ClaimRequest): Promise<{ identity: ClaimIdentity; claimed: ClaimInput['claimed'] }> {
    if (req.kind === 'CODE') {
      const school = (await resolveSchoolReference(tx, { schoolCode: req.schoolCode }, { requireActive: true }))!;
      return { identity: { schoolId: school.id, name: null, country: RWANDA, province: null, district: null, sector: null }, claimed: undefined };
    }
    if (req.kind === 'NOT_LISTED') {
      const place = { province: req.province, district: req.district, sector: req.sector };
      await assertDirectoryPlace(tx, place);
      const key = schoolKey(req.schoolName);
      if (!key) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SCHOOL_NAME', 'The school name must contain letters or digits.');
      const linked = await uniqueOfficialSchoolInPlace(tx, key, place);
      const claimed = { name: req.schoolName, country: RWANDA, ...place };
      return { identity: { schoolId: linked, ...claimed }, claimed };
    }
    const claimed = { name: req.schoolName, country: req.country, province: null, district: null, sector: null };
    return { identity: { schoolId: null, ...claimed }, claimed };
  }

  // ─── PR C: Administrator matching and reopening ─────────────────────────────

  /**
   * Link a current, PENDING, name-only claim to an existing active school. The country must be
   * the claim's; a province / district / sector differing from what the student entered needs
   * confirmDifferentPlace. Ends the claim (RESOLVED), places the student at the school (with the
   * current-year enrolment) and creates a new PENDING claim keeping the original source and the
   * entered details. Verification stays a separate action. Audited: RESOLVED, with both places.
   */
  async match(id: string, dto: MatchAffiliationDto, user: AuthUser) {
    const studentId = await this.studentOf(id);
    const actor: AffiliationActor = { actorId: user.id, actorRole: user.role };
    return this.prisma.$transaction(async (tx) => {
      const student = await this.lockStudent(tx, studentId);
      const row = await this.lockClaim(tx, id);
      if (row.supersededAt) throw conflict('AFFILIATION_SUPERSEDED', 'This claim has been replaced by a newer one.');
      if (row.schoolId) throw conflict('AFFILIATION_ALREADY_RESOLVED', 'This claim is already linked to a school.');
      if (row.status !== 'PENDING') throw conflict('AFFILIATION_STATUS_CONFLICT', 'Only a PENDING claim can be matched.', { status: row.status });
      if (student.role !== 'STUDENT') throw conflict('AFFILIATION_STATUS_CONFLICT', 'The user is no longer a student.');

      const school = await tx.school.findUnique({
        where: { id: dto.schoolId },
        select: { id: true, name: true, code: true, countryCode: true, province: true, district: true, sector: true, isActive: true },
      });
      if (!school) throw new NotFoundException('School not found.');
      const claimedCountry = row.claimedCountry ?? RWANDA;
      if (school.countryCode !== claimedCountry) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_COUNTRY_MISMATCH',
          `The student's school is in ${claimedCountry}; this school is in ${school.countryCode}.`, { claimed: claimedCountry, school: school.countryCode });
      }
      const claimedPlace = { province: row.claimedProvince, district: row.claimedDistrict, sector: row.claimedSector };
      const actualPlace = { province: school.province, district: school.district, sector: school.sector };
      const differs = (['province', 'district', 'sector'] as const).filter((k) => claimedPlace[k] && claimedPlace[k] !== actualPlace[k]);
      if (differs.length && !dto.confirmDifferentPlace) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_PLACE_MISMATCH',
          `The school's ${differs.join(', ')} differ from what the student entered. Repeat with confirmDifferentPlace: true to link it anyway.`,
          { claimed: claimedPlace, actual: actualPlace, differs });
      }
      if (!school.isActive) throw schoolInactive(school.id);

      await this.supersedeLocked(tx, studentId, 'RESOLVED', actor);
      await this.academicYears.enrollInCurrentYear(tx, studentId, student.gradeLevel!, school.id);
      const newId = await this.claim(tx, {
        studentId, schoolId: school.id, claimed: claimedOf(row), source: row.source, reason: 'NEW_CLAIM', actor,
      });
      await this.audit.log({
        ...actor, action: 'SCHOOL_AFFILIATION_RESOLVED', entity: 'StudentSchoolAffiliation', entityId: newId,
        metadata: {
          studentId, previousClaimId: id, schoolId: school.id, source: row.source,
          claimed: { name: row.claimedName, country: claimedCountry, ...claimedPlace },
          actual:  { name: school.name, code: school.code, country: school.countryCode, ...actualPlace },
          placeDiffers: differs, confirmedDifferentPlace: differs.length > 0, note: dto.note ?? null,
        },
      }, tx);
      return tx.studentSchoolAffiliation.findUniqueOrThrow({ where: { id: newId }, select: ADMIN_SELECT });
    });
  }

  /**
   * Reopen the student's CURRENT REJECTED or REVOKED claim as a new PENDING claim for the same
   * school (or the same entered details). Not subject to the student cooldown; an inactive school
   * is still refused (claim() locks it). Audited: REOPENED, with the previous status and reason.
   */
  async reopen(id: string, reason: string, user: AuthUser) {
    const studentId = await this.studentOf(id);
    const actor: AffiliationActor = { actorId: user.id, actorRole: user.role };
    return this.prisma.$transaction(async (tx) => {
      await this.lockStudent(tx, studentId);
      const row = await this.lockClaim(tx, id);
      if (row.supersededAt) throw conflict('AFFILIATION_SUPERSEDED', 'This claim has been replaced by a newer one.');
      if (row.status !== 'REJECTED' && row.status !== 'REVOKED') {
        throw conflict('AFFILIATION_STATUS_CONFLICT', 'Only a REJECTED or REVOKED claim can be reopened.', { status: row.status });
      }
      await this.supersedeLocked(tx, studentId, 'REOPENED', actor);
      const newId = await this.claim(tx, {
        studentId, schoolId: row.schoolId, claimed: claimedOf(row), source: row.source, reason: 'NEW_CLAIM', actor,
      });
      await this.audit.log({
        ...actor, action: 'SCHOOL_AFFILIATION_REOPENED', entity: 'StudentSchoolAffiliation', entityId: newId,
        metadata: { studentId, previousClaimId: id, previousStatus: row.status, schoolId: row.schoolId, reason },
      }, tx);
      return tx.studentSchoolAffiliation.findUniqueOrThrow({ where: { id: newId }, select: ADMIN_SELECT });
    });
  }

  /** Schools a name-only claim may be matched to: the same normalised name in its country (Rwanda: its district, or none recorded). */
  async candidates(id: string) {
    const row = await this.prisma.studentSchoolAffiliation.findUnique({
      where: { id }, select: { claimedName: true, claimedCountry: true, claimedDistrict: true },
    });
    if (!row) throw new NotFoundException('Affiliation not found.');
    const key = row.claimedName ? schoolKey(row.claimedName) : '';
    if (!key) return [];
    const country = row.claimedCountry ?? RWANDA;
    const place = country === RWANDA && row.claimedDistrict
      ? Prisma.sql`AND ("district" = ${row.claimedDistrict} OR "district" IS NULL)`
      : Prisma.empty;
    return this.prisma.$queryRaw<Array<Record<string, unknown>>>`
      SELECT "id", "name", "code", "countryCode", "province", "district", "sector", "isActive" FROM "School"
       WHERE "countryCode" = ${country} AND ("nameKey" = ${key} OR ("nameKey" IS NULL AND ${SQL_NAME_KEY} = ${key})) ${place}
       ORDER BY "isActive" DESC, "name", "id" LIMIT 20`;
  }

  // ─── PR C helpers ───────────────────────────────────────────────────────────

  /** The student's User row, locked (FOR UPDATE) — the first lock of every path — then the per-student lock. */
  private async lockStudent(tx: Prisma.TransactionClient, studentId: string) {
    const [row] = await tx.$queryRaw<Array<{ role: string; gradeLevel: GradeLevel | null; schoolId: string | null }>>`
      SELECT "role"::text AS "role", "gradeLevel"::text AS "gradeLevel", "schoolId" FROM "User" WHERE "id" = ${studentId} FOR UPDATE`;
    if (!row) throw new NotFoundException('User not found.');
    await this.lock(tx, studentId);
    return row;
  }

  private async lockClaim(tx: Prisma.TransactionClient, id: string) {
    const [row] = await tx.$queryRaw<Array<LockedClaim>>`
      SELECT "id", "studentId", "schoolId", "status"::text AS "status", "source"::text AS "source", "supersededAt",
             "claimedName", "claimedCountry", "claimedProvince", "claimedDistrict", "claimedSector"
        FROM "StudentSchoolAffiliation" WHERE "id" = ${id} FOR UPDATE`;
    if (!row) throw new NotFoundException('Affiliation not found.');
    return row;
  }

  private async studentOf(id: string) {
    const row = await this.prisma.studentSchoolAffiliation.findUnique({ where: { id }, select: { studentId: true } });
    if (!row) throw new NotFoundException('Affiliation not found.');
    return row.studentId;
  }

  // ─── Reading ────────────────────────────────────────────────────────────────

  async list(q: ListAffiliationsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.StudentSchoolAffiliationWhereInput = {
      ...((q.current ?? true) && { supersededAt: null }),
      ...(q.status    && { status: q.status }),
      ...(q.schoolId ? { schoolId: q.schoolId } : q.hasSchool !== undefined && { schoolId: q.hasSchool ? { not: null } : null }),
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

function tooMany(code: string, message: string, details: unknown) {
  return new AppError(HttpStatus.TOO_MANY_REQUESTS, code, message, details);
}

interface LockedClaim {
  id: string; studentId: string; schoolId: string | null; status: SchoolAffiliationStatus; source: SchoolAffiliationSource;
  supersededAt: Date | null; claimedName: string | null; claimedCountry: string | null;
  claimedProvince: string | null; claimedDistrict: string | null; claimedSector: string | null;
}

/** Fields of a student's claims used by the request rules (identity, limit, cooldown). */
const HISTORY_SELECT = {
  id: true, schoolId: true, status: true, source: true, createdById: true, createdAt: true,
  decidedAt: true, revokedAt: true, supersededAt: true,
  claimedName: true, claimedCountry: true, claimedProvince: true, claimedDistrict: true, claimedSector: true,
} as const;

function identityOf(c: Pick<LockedClaim, 'schoolId' | 'claimedName' | 'claimedCountry' | 'claimedProvince' | 'claimedDistrict' | 'claimedSector'>): ClaimIdentity {
  return {
    schoolId: c.schoolId, name: c.claimedName, country: c.claimedCountry,
    province: c.claimedProvince, district: c.claimedDistrict, sector: c.claimedSector,
  };
}

/** What the student entered, carried to the claim that replaces this one. */
function claimedOf(c: LockedClaim): ClaimInput['claimed'] {
  return { name: c.claimedName, country: c.claimedCountry, province: c.claimedProvince, district: c.claimedDistrict, sector: c.claimedSector };
}
