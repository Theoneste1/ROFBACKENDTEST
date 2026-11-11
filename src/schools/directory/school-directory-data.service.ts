/**
 * The directory data of a school (school directory S1, M12; owner-approved 2026-11-11).
 * schools.manage: Administrators and Super Admins only.
 *
 *   contacts    e-mail addresses and phone numbers. ADMIN_ONLY by default; REPRESENTATIVES only
 *               after an Administrator verifies the contact and authorises it (also enforced by a
 *               database CHECK). Never deleted: a removed contact is kept with removedAt, and a
 *               changed type or value replaces the contact (the old one kept as removed, the new
 *               one unverified). Full values are returned only by these Administrator routes —
 *               never by public search, registration, the deprecated /schools routes, any export,
 *               or an audit entry (audit entries record a masked value: maskContact).
 *   offerings   education levels and programmes. Programmes that still need review are marked
 *               needsReview and are never presented as verified offerings.
 *   history     the source records the school was matched with, and its audit entries — only for
 *               a caller who also holds audit.view (an Administrator may be denied it).
 *
 * Every write takes the directory lock (shared) and then the school's row lock, and is written
 * in one transaction with its audit record.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import { PermissionService } from '../../auth/permission.service.js';
import type { AuthUser, CallerCtx } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../../common/pagination.js';
import type { Prisma, SchoolContactType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { lockSchoolDirectory } from '../school-locks.js';
import { maskContact, normaliseContact, redactContactText } from './school-contacts.js';
import { PutSchoolContactsDto, PutSchoolOfferingsDto, VerifySchoolContactDto } from './school-directory.dto.js';

type Tx = Prisma.TransactionClient;

const CONTACT_SELECT = {
  id: true, type: true, value: true, rawValue: true, label: true, isPrimary: true, visibility: true,
  verifiedAt: true, verifiedBy: { select: { id: true, username: true } },
  dataSource: { select: { key: true } }, createdAt: true, updatedAt: true,
  removedAt: true, removedBy: { select: { id: true, username: true } },
} as const;

const PROGRAMME_SELECT = { id: true, code: true, name: true, category: true, tvetLevel: true, needsReview: true } as const;

/** What an audit entry records of a contact: a masked value, never the value itself (D6, M1). */
const contactFacts = (c: { id: string; type: SchoolContactType; value: string; label: string | null; isPrimary: boolean }) =>
  ({ id: c.id, type: c.type, masked: maskContact(c.type, c.value), label: c.label, isPrimary: c.isPrimary });

/**
 * The Administrator's reason for a contact change, as recorded in the audit entry: kept, with any
 * e-mail address or phone number in it masked (reasonRedacted marks that something was masked).
 */
const contactReason = (reason: string | undefined) => {
  if (!reason) return { reason: null };
  const r = redactContactText(reason);
  return { reason: r.text, ...(r.redacted && { reasonRedacted: true }) };
};

@Injectable()
export class SchoolDirectoryDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
    private readonly permissions: PermissionService,
  ) {}

  // ─── Reference data ─────────────────────────────────────────────────────────

  async referenceData() {
    const [educationLevels, programmes] = await this.prisma.$transaction([
      this.prisma.educationLevel.findMany({ orderBy: { sortOrder: 'asc' } }),
      this.prisma.programme.findMany({ orderBy: [{ category: 'asc' }, { name: 'asc' }], select: PROGRAMME_SELECT }),
    ]);
    return { educationLevels, programmes };
  }

  // ─── Contacts ───────────────────────────────────────────────────────────────

  async contacts(schoolId: string, includeRemoved = false) {
    await this.assertSchool(this.prisma, schoolId);
    return { schoolId, contacts: await this.listContacts(this.prisma, schoolId, includeRemoved) };
  }

  async putContacts(schoolId: string, dto: PutSchoolContactsDto, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSchool(tx, schoolId);
      const existing = await tx.schoolContact.findMany({ where: { schoolId, removedAt: null } });
      const byId = new Map(existing.map((c) => [c.id, c]));

      const problems: string[] = [];
      const wanted = dto.contacts.map((c, i) => {
        const n = normaliseContact(c.type, c.value);
        if ('problem' in n) problems.push(`contacts[${i}]: ${n.problem}`);
        if (c.id && !byId.has(c.id)) problems.push(`contacts[${i}]: not an active contact of this school.`);
        return {
          i, id: c.id ?? null, type: c.type, value: 'value' in n ? n.value : '', rawValue: c.value.trim(),
          label: c.label ?? null, isPrimary: c.isPrimary ?? false,
        };
      });
      const seenIds = new Set<string>();
      const seenValues = new Map<string, number>();
      const primaries = new Map<SchoolContactType, number>();
      for (const w of wanted) {
        if (w.id && seenIds.has(w.id)) problems.push(`contacts[${w.i}]: the same contact is listed twice.`);
        if (w.id) seenIds.add(w.id);
        const k = `${w.type}|${w.value}`;
        if (w.value && seenValues.has(k)) problems.push(`contacts[${w.i}]: repeats contacts[${seenValues.get(k)}].`);
        else seenValues.set(k, w.i);
        if (w.isPrimary) primaries.set(w.type, (primaries.get(w.type) ?? 0) + 1);
      }
      for (const [type, n] of primaries) if (n > 1) problems.push(`At most one primary ${type.toLowerCase()} contact (${n} given).`);
      if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_CONTACTS', problems.join(' '), { problems });

      const keep = new Set(wanted.flatMap((w) => (w.id ? [w.id] : [])));
      const removed = existing.filter((c) => !keep.has(c.id));
      const added = wanted.filter((w) => !w.id);
      const changed = wanted.flatMap((w) => {
        const before = w.id ? byId.get(w.id)! : null;
        if (!before) return [];
        const valueChanged = before.type !== w.type || before.value !== w.value;
        if (!valueChanged && before.label === w.label && before.isPrimary === w.isPrimary) return [];
        return [{ before, after: w, valueChanged }];
      });
      if (!removed.length && !added.length && !changed.length) {
        return { schoolId, changed: false, contacts: await this.listContacts(tx, schoolId) };
      }

      // Never deleted: removed and replaced contacts are kept with removedAt (Administrators only).
      const now = new Date();
      const replaced = changed.filter((c) => c.valueChanged);
      const retire = [...removed.map((c) => c.id), ...replaced.map((c) => c.before.id)];
      if (retire.length) await tx.schoolContact.updateMany({ where: { id: { in: retire } }, data: { removedAt: now, removedById: caller.id } });
      for (const { before, after } of changed.filter((c) => !c.valueChanged)) {
        await tx.schoolContact.update({ where: { id: before.id }, data: { label: after.label, isPrimary: after.isPrimary } });
      }
      const newContact = (a: (typeof wanted)[number]) => tx.schoolContact.create({
        data: { schoolId, type: a.type, value: a.value, rawValue: a.rawValue, label: a.label, isPrimary: a.isPrimary },
      });
      const created = [];
      for (const a of added) created.push(await newContact(a));
      const replacements = [];
      for (const { before, after } of replaced) replacements.push({ before, after: await newContact(after) });

      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'UPDATE_SCHOOL_CONTACTS', entity: 'School', entityId: schoolId,
        metadata: {
          added: created.map(contactFacts),
          changed: changed.filter((c) => !c.valueChanged).map(({ before, after }) => ({
            id: before.id, from: contactFacts(before), to: contactFacts({ ...after, id: before.id }),
          })),
          replaced: replacements.map(({ before, after }) => ({
            id: before.id, replacedBy: after.id, from: contactFacts(before), to: contactFacts(after),
            verificationReset: before.verifiedAt !== null, previousVisibility: before.visibility,
          })),
          removed: removed.map((c) => ({ ...contactFacts(c), verified: c.verifiedAt !== null, visibility: c.visibility })),
          ...contactReason(dto.reason),
        },
      }, tx);
      return { schoolId, changed: true, contacts: await this.listContacts(tx, schoolId) };
    });
  }

  async verifyContact(schoolId: string, contactId: string, dto: VerifySchoolContactDto, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSchool(tx, schoolId);
      const contact = await tx.schoolContact.findFirst({ where: { id: contactId, schoolId, removedAt: null } });
      if (!contact) throw new NotFoundException('No active contact with this id for this school.');
      const visibility = dto.visibility ?? 'ADMIN_ONLY';
      const updated = await tx.schoolContact.update({
        where: { id: contactId },
        data: { verifiedAt: new Date(), verifiedById: caller.id, visibility },
        select: CONTACT_SELECT,
      });
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'SCHOOL_CONTACT_VERIFIED', entity: 'School', entityId: schoolId,
        metadata: {
          contact: contactFacts(contact), visibility,
          previous: { verifiedAt: contact.verifiedAt?.toISOString() ?? null, visibility: contact.visibility },
          ...contactReason(dto.reason),
        },
      }, tx);
      return updated;
    });
  }

  // ─── Offerings ──────────────────────────────────────────────────────────────

  async offerings(schoolId: string) {
    await this.assertSchool(this.prisma, schoolId);
    return { schoolId, ...(await this.listOfferings(this.prisma, schoolId)) };
  }

  async putOfferings(schoolId: string, dto: PutSchoolOfferingsDto, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSchool(tx, schoolId);
      const problems: string[] = [];
      const levelCodes = dto.levels.map((l) => l.code);
      const programmeIds = dto.programmes.map((p) => p.id);
      if (new Set(levelCodes).size !== levelCodes.length) problems.push('An education level is listed twice.');
      if (new Set(programmeIds).size !== programmeIds.length) problems.push('A programme is listed twice.');
      const knownLevels = new Set((await tx.educationLevel.findMany({ where: { code: { in: levelCodes } }, select: { code: true } })).map((l) => l.code));
      const unknownLevels = levelCodes.filter((c) => !knownLevels.has(c));
      if (unknownLevels.length) problems.push(`Unknown education level: ${[...new Set(unknownLevels)].join(', ')}.`);
      const knownProgrammes = new Set((await tx.programme.findMany({ where: { id: { in: programmeIds } }, select: { id: true } })).map((p) => p.id));
      const unknownProgrammes = programmeIds.filter((id) => !knownProgrammes.has(id));
      if (unknownProgrammes.length) problems.push(`Unknown programme: ${[...new Set(unknownProgrammes)].join(', ')}.`);
      if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_OFFERINGS', problems.join(' '), { problems });

      const levels = await tx.schoolEducationLevel.findMany({ where: { schoolId } });
      const programmes = await tx.schoolProgramme.findMany({ where: { schoolId } });
      const levelBefore = new Map(levels.map((l) => [l.levelCode, l.qualifier]));
      const wantedLevels = new Map(dto.levels.map((l) => [l.code, l.qualifier ?? null]));
      const levelsAdded = [...wantedLevels].filter(([c]) => !levelBefore.has(c));
      const levelsRemoved = [...levelBefore].filter(([c]) => !wantedLevels.has(c));
      const levelsChanged = [...wantedLevels].filter(([c, q]) => levelBefore.has(c) && levelBefore.get(c) !== q);
      const programmeBefore = new Set(programmes.map((p) => p.programmeId));
      const programmesAdded = programmeIds.filter((id) => !programmeBefore.has(id));
      const programmesRemoved = [...programmeBefore].filter((id) => !programmeIds.includes(id));
      if (!levelsAdded.length && !levelsRemoved.length && !levelsChanged.length && !programmesAdded.length && !programmesRemoved.length) {
        return { schoolId, changed: false, ...(await this.listOfferings(tx, schoolId)) };
      }

      if (levelsRemoved.length) await tx.schoolEducationLevel.deleteMany({ where: { schoolId, levelCode: { in: levelsRemoved.map(([c]) => c) } } });
      for (const [code, qualifier] of levelsChanged) {
        await tx.schoolEducationLevel.update({ where: { schoolId_levelCode: { schoolId, levelCode: code } }, data: { qualifier } });
      }
      if (levelsAdded.length) await tx.schoolEducationLevel.createMany({ data: levelsAdded.map(([levelCode, qualifier]) => ({ schoolId, levelCode, qualifier })) });
      if (programmesRemoved.length) await tx.schoolProgramme.deleteMany({ where: { schoolId, programmeId: { in: programmesRemoved } } });
      if (programmesAdded.length) await tx.schoolProgramme.createMany({ data: programmesAdded.map((programmeId) => ({ schoolId, programmeId })) });

      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'UPDATE_SCHOOL_OFFERINGS', entity: 'School', entityId: schoolId,
        metadata: {
          levels: {
            added: levelsAdded.map(([code, qualifier]) => ({ code, qualifier })),
            removed: levelsRemoved.map(([code, qualifier]) => ({ code, qualifier })),
            changed: levelsChanged.map(([code, qualifier]) => ({ code, from: levelBefore.get(code) ?? null, to: qualifier })),
          },
          programmes: { added: programmesAdded, removed: programmesRemoved },
          reason: dto.reason ?? null,
        },
      }, tx);
      return { schoolId, changed: true, ...(await this.listOfferings(tx, schoolId)) };
    });
  }

  // ─── History ────────────────────────────────────────────────────────────────

  /**
   * Every source record matched with the school, and its audit entries (newest first, paginated)
   * when the caller also holds audit.view — otherwise audit is null and auditVisible false.
   */
  async history(schoolId: string, q: PaginationQueryDto, caller: AuthUser) {
    await this.assertSchool(this.prisma, schoolId);
    const auditVisible = this.permissions.has(caller, 'audit.view');
    const sourceRecords = await this.prisma.schoolSourceRecord.findMany({
      where: { schoolId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, dataSource: { select: { key: true, name: true } }, datasetLabel: true, datasetSha256: true, sourceRef: true,
        raw: true, rowHash: true, matchedBy: true, issues: true, createdAt: true,
      },
    });
    if (!auditVisible) return { schoolId, sourceRecords, auditVisible, audit: null };
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.AuditLogWhereInput = { entity: 'School', entityId: schoolId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, action: true, actorId: true, actorUsername: true, actorRole: true, metadata: true, createdAt: true },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { schoolId, sourceRecords, auditVisible, audit: paginated(rows, total, page, limit) };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  /** The directory lock (shared), then the school's row (FOR UPDATE); 404 when there is no such school. */
  private async lockSchool(tx: Tx, schoolId: string) {
    await lockSchoolDirectory(tx, 'shared');
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "School" WHERE "id" = ${schoolId} FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('School not found.');
  }

  private async assertSchool(db: Pick<Tx, 'school'>, schoolId: string) {
    if (!(await db.school.findUnique({ where: { id: schoolId }, select: { id: true } }))) throw new NotFoundException('School not found.');
  }

  /** Active contacts; with includeRemoved, the removed and replaced ones too (after the active ones). */
  private listContacts(db: Pick<Tx, 'schoolContact'>, schoolId: string, includeRemoved = false) {
    return db.schoolContact.findMany({
      where: { schoolId, ...(!includeRemoved && { removedAt: null }) },
      orderBy: [{ removedAt: { sort: 'desc', nulls: 'first' } }, { type: 'asc' }, { isPrimary: 'desc' }, { value: 'asc' }, { id: 'asc' }],
      select: CONTACT_SELECT,
    });
  }

  private async listOfferings(db: Pick<Tx, 'schoolEducationLevel' | 'schoolProgramme'>, schoolId: string) {
    const levels = await db.schoolEducationLevel.findMany({
      where: { schoolId }, orderBy: { level: { sortOrder: 'asc' } },
      select: { levelCode: true, qualifier: true, sourceToken: true, level: { select: { name: true } } },
    });
    const programmes = await db.schoolProgramme.findMany({
      where: { schoolId }, orderBy: [{ programme: { category: 'asc' } }, { programme: { name: 'asc' } }],
      select: { sourceToken: true, programme: { select: PROGRAMME_SELECT } },
    });
    return {
      levels: levels.map((l) => ({ code: l.levelCode, name: l.level.name, qualifier: l.qualifier, sourceToken: l.sourceToken })),
      programmes: programmes.map((p) => ({ ...p.programme, sourceToken: p.sourceToken })),
    };
  }
}
