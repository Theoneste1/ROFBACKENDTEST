/**
 * School administration (PR B; owner-approved 2026-11-11). schools.manage: Administrators and
 * Super Admins.
 *
 *   create     the ONLY way a school record is created in the application (invitations, CSV
 *              imports and registration never create one). Rwanda: a place from the official
 *              directory and an optional official code (6 digits, first digit = province).
 *              Another country (ISO 3166-1 alpha-2): a location, never a code.
 *   update     the id never changes, so students, claims and their verification status,
 *              enrolments, submissions and Teacher assignments are unaffected.
 *   setActive  deactivation keeps every existing record and Teacher access; it only refuses new
 *              claims, registrations and Teacher assignments (school-usage.ts). Reactivation
 *              restores that eligibility; history is never rewritten.
 *
 * Every change and its audit record are written in one transaction. Name and code are unique
 * (409 SCHOOL_NAME_TAKEN / SCHOOL_CODE_TAKEN, also when two requests race). A school with the
 * same normalised name in the same district (Rwanda; or with no district recorded) or the same
 * country is a POSSIBLE_DUPLICATE (409) unless the request confirms it; the confirmation is
 * audited. The duplicate check and the write run under an advisory lock on the normalised name,
 * so two concurrent requests cannot both pass the check.
 *
 * PR D: the rules live in school-validation.ts (shared with the bulk import), and every write
 * takes its locks through schoolLockPlan / lockSchoolKeys (school-locks.ts): the edited school's
 * row first, then sorted name locks, then sorted code locks.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../common/pagination.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateSchoolDto, ListAdminSchoolsDto, SetSchoolActiveDto, UpdateSchoolDto } from './dto/admin-school.dto.js';
import { lockSchoolKeys, schoolLockPlan } from './school-locks.js';
import { RWANDA } from './school-rules.js';
import {
  assertCodeFree, assertNameFree, assertSchoolPlace, codeTaken, EDITABLE, findPossibleDuplicates, nameTaken,
  newSchoolRecord, possibleDuplicateError, schoolNameKey, schoolSnapshot, validateSchoolFields,
  type DuplicateCandidate, type Editable, type SchoolFields,
} from './school-validation.js';

type Tx = Prisma.TransactionClient;
type Place = SchoolFields;

const SCHOOL_SELECT = {
  id: true, name: true, code: true, countryCode: true, province: true, district: true, sector: true,
  location: true, ownership: true, source: true, isActive: true, createdAt: true, updatedAt: true,
  createdBy: { select: { id: true, username: true } },
} as const;

@Injectable()
export class AdminSchoolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
  ) {}

  // ─── Reading ────────────────────────────────────────────────────────────────

  async list(q: ListAdminSchoolsDto) {
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.SchoolWhereInput = {
      ...(q.q && { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { code: { startsWith: q.q } }] }),
      ...(q.countryCode && { countryCode: q.countryCode }),
      ...(q.province && { province: q.province }),
      ...(q.district && { district: q.district }),
      ...(q.sector && { sector: q.sector }),
      ...(q.isActive !== undefined && { isActive: q.isActive }),
      ...(q.source && { source: q.source }),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.school.findMany({
        where, skip, take, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { ...SCHOOL_SELECT, _count: { select: { students: true } } },
      }),
      this.prisma.school.count({ where }),
    ]);
    const verified = rows.length
      ? await this.prisma.studentSchoolAffiliation.groupBy({
          by: ['schoolId'], where: { schoolId: { in: rows.map((r) => r.id) }, supersededAt: null, status: 'VERIFIED' }, _count: { _all: true },
        })
      : [];
    const verifiedBy = new Map(verified.map((v) => [v.schoolId, v._count._all]));
    return paginated(
      rows.map(({ _count, ...s }) => ({ ...s, students: _count.students, verifiedStudents: verifiedBy.get(s.id) ?? 0 })),
      total, page, limit,
    );
  }

  async get(id: string) {
    const school = await this.prisma.school.findUnique({ where: { id }, select: SCHOOL_SELECT });
    if (!school) throw new NotFoundException('School not found.');
    return { ...school, counts: await this.impact(this.prisma, id) };
  }

  /** The school's students, each with the status of their current claim for THIS school (null: none). */
  async students(id: string, q: PaginationQueryDto) {
    const school = await this.prisma.school.findUnique({ where: { id }, select: { id: true } });
    if (!school) throw new NotFoundException('School not found.');
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.UserWhereInput = { schoolId: id, role: 'STUDENT' };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where, skip, take, orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
        select: {
          id: true, username: true, firstName: true, lastName: true, gradeLevel: true, isActive: true, isApproved: true,
          division: { select: { id: true, code: true, name: true } },
          schoolAffiliations: { where: { supersededAt: null }, take: 1, select: { id: true, schoolId: true, status: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    return paginated(rows.map(({ schoolAffiliations: [claim], ...u }) => ({
      ...u,
      claim: claim && claim.schoolId === id ? { id: claim.id, status: claim.status } : null,
    })), total, page, limit);
  }

  // ─── Creating ───────────────────────────────────────────────────────────────

  async create(dto: CreateSchoolDto, caller: CallerCtx) {
    const place = this.placeFor({
      name: dto.name, countryCode: dto.countryCode ?? RWANDA, code: dto.code ?? null,
      province: dto.province ?? null, district: dto.district ?? null, sector: dto.sector ?? null,
      location: dto.location ?? null, ownership: dto.ownership ?? null,
    });
    const key = this.nameKey(place.name!);

    return this.write(async (tx) => {
      await lockSchoolKeys(tx, schoolLockPlan([{ before: null, after: { ...place, isActive: true } }]));
      await this.assertDirectoryPlace(tx, place);
      await this.assertNameFree(tx, place.name!, null);
      if (place.code) await this.assertCodeFree(tx, place.code, null);
      const candidates = await this.possibleDuplicates(tx, key, place, null);
      this.assertNoDuplicate(candidates, dto.confirmPossibleDuplicate);

      const school = await tx.school.create({ data: newSchoolRecord(place, key, caller.id), select: SCHOOL_SELECT });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'CREATE_SCHOOL', entity: 'School', entityId: school.id,
        metadata: {
          school: this.snapshot(school),
          ...(candidates.length && { confirmedPossibleDuplicate: true, possibleDuplicates: candidates.map((c) => c.id) }),
        },
      }, tx);
      return school;
    });
  }

  // ─── Editing ────────────────────────────────────────────────────────────────

  async update(id: string, dto: UpdateSchoolDto, caller: CallerCtx) {
    return this.write(async (tx) => {
      const current = await this.lockSchool(tx, id);
      const before: Place = Object.fromEntries(EDITABLE.map((k) => [k, current[k] ?? null])) as Place;
      const requested = Object.fromEntries(EDITABLE.filter((k) => dto[k] !== undefined).map((k) => [k, dto[k] ?? null]));
      const after = this.placeFor({ ...before, ...requested } as Place, { legacy: current.source === 'LEGACY' });
      const changes = Object.fromEntries(EDITABLE.filter((k) => after[k] !== before[k]).map((k) => [k, { from: before[k], to: after[k] }]));
      if (Object.keys(changes).length === 0) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'NO_CHANGES', 'Nothing to change: every field already has this value.');
      }
      const changed = (k: Editable) => k in changes;
      if (before.code && !after.code) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_CODE_REQUIRED', 'A school code cannot be removed.');
      }
      const directoryChange = (['name', 'countryCode', 'province', 'district', 'sector'] as const).some(changed);
      if (!dto.reason && (changed('code') || (current.source === 'OFFICIAL_LIST' && directoryChange))) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'REASON_REQUIRED',
          'A reason is required to set or change a school code, or to change the name, country or place of an official-directory school.');
      }

      const key = this.nameKey(after.name!);
      await lockSchoolKeys(tx, schoolLockPlan([{
        before: { ...before, isActive: current.isActive }, after: { ...after, isActive: current.isActive },
      }]));
      if ((['countryCode', 'province', 'district', 'sector', 'code'] as const).some(changed)) await this.assertDirectoryPlace(tx, after);
      if (changed('name')) await this.assertNameFree(tx, after.name!, id);
      if (changed('code')) await this.assertCodeFree(tx, after.code!, id);
      const candidates = changed('name') || changed('district') || changed('countryCode')
        ? await this.possibleDuplicates(tx, key, after, id)
        : [];
      this.assertNoDuplicate(candidates, dto.confirmPossibleDuplicate);

      const school = await tx.school.update({
        where: { id },
        data: { ...(requested as Prisma.SchoolUncheckedUpdateInput), ...(changed('name') && { nameKey: key }) },
        select: SCHOOL_SELECT,
      });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'UPDATE_SCHOOL', entity: 'School', entityId: id,
        metadata: {
          changes, reason: dto.reason ?? null,
          ...(candidates.length && { confirmedPossibleDuplicate: true, possibleDuplicates: candidates.map((c) => c.id) }),
        },
      }, tx);
      return school;
    });
  }

  // ─── Deactivating / reactivating ────────────────────────────────────────────

  /**
   * The row lock (FOR UPDATE) waits for every claim, verification and Teacher assignment in
   * progress for this school (they hold FOR SHARE); after this commits, new ones are refused.
   * Setting the state it already has changes nothing and writes no audit record.
   */
  async setActive(id: string, dto: SetSchoolActiveDto, caller: CallerCtx) {
    return this.write(async (tx) => {
      const current = await this.lockSchool(tx, id);
      const fields = { name: current.name, code: current.code, countryCode: current.countryCode, district: current.district };
      await lockSchoolKeys(tx, schoolLockPlan([{
        before: { ...fields, isActive: current.isActive }, after: { ...fields, isActive: dto.isActive },
      }]));
      const impact = await this.impact(tx, id);
      if (current.isActive === dto.isActive) {
        return { school: await tx.school.findUniqueOrThrow({ where: { id }, select: SCHOOL_SELECT }), changed: false, impact };
      }
      const school = await tx.school.update({ where: { id }, data: { isActive: dto.isActive }, select: SCHOOL_SELECT });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: dto.isActive ? 'SCHOOL_REACTIVATED' : 'SCHOOL_DEACTIVATED',
        entity: 'School', entityId: id,
        metadata: { reason: dto.reason, previous: { isActive: current.isActive }, next: { isActive: dto.isActive }, impact },
      }, tx);
      return {
        school, changed: true, impact,
        ...(!dto.isActive && {
          warning: 'Existing students, verified claims, enrolments and Teacher access are kept. ' +
            'The school accepts no new registrations, claims, verifications or Teacher assignments until reactivated.',
        }),
      };
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** One transaction; a unique-constraint race on name or code becomes the specific 409. */
  private async write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(fn);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const target = JSON.stringify(err.meta ?? {});
        throw /code/i.test(target) ? codeTaken() : nameTaken();
      }
      throw err;
    }
  }

  private async lockSchool(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT 1 FROM "School" WHERE "id" = ${id} FOR UPDATE`;
    const school = await tx.school.findUnique({
      where: { id },
      select: {
        name: true, countryCode: true, code: true, province: true, district: true, sector: true, location: true, ownership: true,
        source: true, isActive: true,
      },
    });
    if (!school) throw new NotFoundException('School not found.');
    return school;
  }

  private nameKey(name: string) {
    return schoolNameKey(name);
  }

  private placeFor(p: Place, opts: { legacy?: boolean } = {}): Place {
    return validateSchoolFields(p, opts);
  }

  private assertDirectoryPlace(tx: Tx, p: Place) {
    return assertSchoolPlace(tx, p);
  }

  private assertNameFree(tx: Tx, name: string, exceptId: string | null) {
    return assertNameFree(tx, name, exceptId);
  }

  private assertCodeFree(tx: Tx, code: string, exceptId: string | null) {
    return assertCodeFree(tx, code, exceptId);
  }

  private possibleDuplicates(tx: Tx, key: string, p: Place, exceptId: string | null) {
    return findPossibleDuplicates(tx, key, p, exceptId);
  }

  private assertNoDuplicate(candidates: DuplicateCandidate[], confirmed?: boolean) {
    if (candidates.length && !confirmed) throw possibleDuplicateError(candidates);
  }

  /** What deactivating (or reactivating) the school touches — none of it is changed. */
  private async impact(db: Pick<Tx, 'user' | 'studentSchoolAffiliation' | 'teacherSchoolAssignment' | 'studentEnrollment'>, id: string) {
    // One after another: inside a transaction they share one connection.
    const students                 = await db.user.count({ where: { schoolId: id, role: 'STUDENT' } });
    const verifiedStudents         = await db.studentSchoolAffiliation.count({ where: { schoolId: id, supersededAt: null, status: 'VERIFIED' } });
    const pendingClaims            = await db.studentSchoolAffiliation.count({ where: { schoolId: id, supersededAt: null, status: 'PENDING' } });
    const activeTeacherAssignments = await db.teacherSchoolAssignment.count({ where: { schoolId: id, isActive: true } });
    const enrolments               = await db.studentEnrollment.count({ where: { schoolId: id } });
    return { students, verifiedStudents, pendingClaims, activeTeacherAssignments, enrolments };
  }

  private snapshot(s: Record<string, unknown>) {
    return schoolSnapshot(s);
  }
}
