/**
 * The directory data of a school (school directory S1, M12; owner-approved 2026-11-11).
 * schools.manage: Administrators and Super Admins only.
 *
 *   contacts    e-mail addresses and phone numbers. ADMIN_ONLY by default; REPRESENTATIVES only
 *               after an Administrator verifies the contact and authorises it (also enforced by a
 *               database CHECK). A changed type or value loses its verification. Contacts are
 *               never returned by public search, registration, the deprecated /schools routes or
 *               any export.
 *   offerings   education levels and programmes. Programmes that still need review are marked
 *               needsReview and are never presented as verified offerings.
 *   history     the school's audit entries and the source records it was matched with.
 *
 * Every write takes the directory lock (shared) and then the school's row lock, and is written
 * in one transaction with its audit record.
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service.js';
import type { CallerCtx } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { pageArgs, paginated, type PaginationQueryDto } from '../../common/pagination.js';
import type { Prisma, SchoolContactType } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { lockSchoolDirectory } from '../school-locks.js';
import { normaliseContact } from './school-contacts.js';
import { PutSchoolContactsDto, PutSchoolOfferingsDto, VerifySchoolContactDto } from './school-directory.dto.js';

type Tx = Prisma.TransactionClient;

const CONTACT_SELECT = {
  id: true, type: true, value: true, rawValue: true, label: true, isPrimary: true, visibility: true,
  verifiedAt: true, verifiedBy: { select: { id: true, username: true } },
  dataSource: { select: { key: true } }, createdAt: true, updatedAt: true,
} as const;

const PROGRAMME_SELECT = { id: true, code: true, name: true, category: true, tvetLevel: true, needsReview: true } as const;

/** What an audit entry records of a contact. */
const contactFacts = (c: { id: string; type: string; value: string; label: string | null; isPrimary: boolean }) =>
  ({ id: c.id, type: c.type, value: c.value, label: c.label, isPrimary: c.isPrimary });

@Injectable()
export class SchoolDirectoryDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
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

  async contacts(schoolId: string) {
    await this.assertSchool(this.prisma, schoolId);
    return { schoolId, contacts: await this.listContacts(this.prisma, schoolId) };
  }

  async putContacts(schoolId: string, dto: PutSchoolContactsDto, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSchool(tx, schoolId);
      const existing = await tx.schoolContact.findMany({ where: { schoolId } });
      const byId = new Map(existing.map((c) => [c.id, c]));

      const problems: string[] = [];
      const wanted = dto.contacts.map((c, i) => {
        const n = normaliseContact(c.type, c.value);
        if ('problem' in n) problems.push(`contacts[${i}]: ${n.problem}`);
        if (c.id && !byId.has(c.id)) problems.push(`contacts[${i}]: not a contact of this school.`);
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

      if (removed.length) await tx.schoolContact.deleteMany({ where: { id: { in: removed.map((c) => c.id) } } });
      // Values may be exchanged between contacts: free each changed value first (unique per school,
      // type and value). The placeholder starts with a control character, which no entered value can contain.
      for (const { before } of changed.filter((c) => c.valueChanged)) {
        await tx.schoolContact.update({ where: { id: before.id }, data: { value: `\u0001moving:${before.id}` } });
      }
      for (const { before, after, valueChanged } of changed) {
        await tx.schoolContact.update({
          where: { id: before.id },
          data: {
            type: after.type, value: after.value, label: after.label, isPrimary: after.isPrimary,
            ...(valueChanged && { rawValue: after.rawValue, verifiedAt: null, verifiedById: null, visibility: 'ADMIN_ONLY', dataSourceId: null }),
          },
        });
      }
      const created = [];
      for (const a of added) {
        created.push(await tx.schoolContact.create({
          data: { schoolId, type: a.type, value: a.value, rawValue: a.rawValue, label: a.label, isPrimary: a.isPrimary },
        }));
      }

      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'UPDATE_SCHOOL_CONTACTS', entity: 'School', entityId: schoolId,
        metadata: {
          added: created.map(contactFacts),
          changed: changed.map(({ before, after, valueChanged }) => ({
            id: before.id, from: contactFacts(before), to: contactFacts({ ...after, id: before.id }),
            ...(valueChanged && { verificationReset: before.verifiedAt !== null, previousVisibility: before.visibility }),
          })),
          removed: removed.map((c) => ({ ...contactFacts(c), verified: c.verifiedAt !== null, visibility: c.visibility })),
          reason: dto.reason ?? null,
        },
      }, tx);
      return { schoolId, changed: true, contacts: await this.listContacts(tx, schoolId) };
    });
  }

  async verifyContact(schoolId: string, contactId: string, dto: VerifySchoolContactDto, caller: CallerCtx) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockSchool(tx, schoolId);
      const contact = await tx.schoolContact.findFirst({ where: { id: contactId, schoolId } });
      if (!contact) throw new NotFoundException('Contact not found for this school.');
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
          reason: dto.reason ?? null,
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

  /** The school's audit entries (newest first, paginated) and every source record matched with it. */
  async history(schoolId: string, q: PaginationQueryDto) {
    await this.assertSchool(this.prisma, schoolId);
    const { page, limit, skip, take } = pageArgs(q);
    const where: Prisma.AuditLogWhereInput = { entity: 'School', entityId: schoolId };
    const [rows, total, sourceRecords] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where, skip, take, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, action: true, actorId: true, actorUsername: true, actorRole: true, metadata: true, createdAt: true },
      }),
      this.prisma.auditLog.count({ where }),
      this.prisma.schoolSourceRecord.findMany({
        where: { schoolId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true, dataSource: { select: { key: true, name: true } }, datasetLabel: true, datasetSha256: true, sourceRef: true,
          raw: true, rowHash: true, matchedBy: true, issues: true, createdAt: true,
        },
      }),
    ]);
    return { schoolId, sourceRecords, audit: paginated(rows, total, page, limit) };
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

  private listContacts(db: Pick<Tx, 'schoolContact'>, schoolId: string) {
    return db.schoolContact.findMany({ where: { schoolId }, orderBy: [{ type: 'asc' }, { isPrimary: 'desc' }, { value: 'asc' }], select: CONTACT_SELECT });
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
