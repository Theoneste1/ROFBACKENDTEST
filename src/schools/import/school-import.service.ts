/**
 * Bulk school import (school administration PR D; owner-approved 2026-11-11). schools.manage.
 *
 * The one authorised exception to "schools are created only by AdminSchoolsService.create"
 * (school-creation.guard.spec.ts). Every row passes exactly the single-create rules: the same
 * CreateSchoolDto validation, then the same functions of school-validation.ts — and is written
 * with the same newSchoolRecord (active, source ADMIN, the importer as creator). An import only
 * creates: an existing code is a row error; no school is ever changed, and the official
 * directory (provinces, districts, sectors, OFFICIAL_LIST) is never touched. Names are not unique
 * (school directory S1, M12): a same-name school in the same district (or country) is a possible
 * duplicate, elsewhere simply another school; created schools are mapped back to their rows by
 * ids assigned up front, never by name.
 *
 *   dry run      validates against the database without locks or writes; when rows have possible
 *                duplicates it returns them with a signed review token (review-token.ts)
 *   real import  ONE transaction: the directory lock (shared, S1), then sorted name locks, then
 *                sorted code locks (school-locks.ts);
 *                every check again under the locks; possible duplicates rebuilt and compared with
 *                the token (a change → 409 IMPORT_REVIEW_OUTDATED); then every school and every
 *                audit record — or nothing at all (all-or-nothing)
 *   refusal      422 / 409: the transaction is rolled back (no CREATE_SCHOOL record) and an
 *                IMPORT_SCHOOLS_REFUSED summary is written separately
 */
import { createHash, randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AuditService } from '../../audit/audit.service.js';
import type { CallerCtx } from '../../common/auth-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { CreateSchoolDto } from '../dto/admin-school.dto.js';
import { directoryPlaceProblem, SQL_NAME_KEY } from '../school-directory.js';
import { lockSchoolDirectory, lockSchoolKeys, schoolLockPlan } from '../school-locks.js';
import { RWANDA } from '../school-rules.js';
import {
  codeTaken, newSchoolRecord, schoolNameKey, schoolSnapshot, validateSchoolFields, type SchoolFields,
} from '../school-validation.js';
import { sanitizeFileName } from './file-name.js';
import { checkReviewToken, reviewKey, signReviewToken, snapshotDigest, type ReviewCandidate, type ReviewRow } from './review-token.js';
import { ImportSchoolsQueryDto } from './school-import.dto.js';
import { parseSchoolImport, type ImportRow } from './school-import.parser.js';

type Db = Pick<Prisma.TransactionClient, 'school' | '$queryRaw'>;

interface PreparedRow { row: number; fields: SchoolFields | null; key: string | null; errors: string[] }
interface Evaluation {
  errors: Array<{ row: number; errors: string[] }>;
  possibleDuplicates: Array<{ row: number; name: string; candidates: Array<ReviewCandidate & { countryCode: string }> }>;
}

/** A refused real import: the transaction is rolled back, then the refusal is audited. */
class ImportRefused extends Error {
  constructor(readonly error: AppError, readonly reason: string, readonly counts: Record<string, number>) { super(reason); }
}

const CANDIDATES_PER_ROW = 20;

@Injectable()
export class SchoolImportService {
  private readonly key: Buffer;
  /** The clock (tests move it to expire review tokens). */
  now = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit:  AuditService,
    config: ConfigService,
  ) {
    this.key = reviewKey(config.getOrThrow<string>('JWT_SECRET'));
  }

  async run(file: Express.Multer.File | undefined, q: ImportSchoolsQueryDto, caller: CallerCtx) {
    const fileName = sanitizeFileName(file?.originalname);
    const parsed = await parseSchoolImport(file);
    const fileSha256 = createHash('sha256').update(file!.buffer).digest('hex');
    const rows = await this.prepare(parsed.rows);
    const meta = { fileName, fileSha256, format: parsed.format, totalRows: rows.length };

    if (q.dryRun) {
      const result = await this.evaluate(this.prisma, rows);
      const valid = rows.length - result.errors.length;
      const token = result.errors.length === 0 && result.possibleDuplicates.length > 0 ? this.token(caller, fileSha256, result) : null;
      await this.audit.log({
        actorId: caller.id, actorRole: caller.role, action: 'IMPORT_SCHOOLS_DRY_RUN', entity: 'School',
        metadata: { ...meta, valid, failed: result.errors.length, possibleDuplicateRows: result.possibleDuplicates.length },
      });
      return {
        dryRun: true, totalRows: rows.length, valid, failed: result.errors.length,
        errors: result.errors, possibleDuplicates: result.possibleDuplicates,
        ...(token && { reviewToken: token.token, reviewExpiresAt: token.expiresAt.toISOString() }),
        canImport: result.errors.length === 0,
      };
    }

    // Token presence, signature, Administrator and file — before any lock or write.
    let tokenSnap: { snap: string; exp: number } | null = null;
    if (q.confirmPossibleDuplicates) {
      if (!q.reviewToken) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'REVIEW_TOKEN_REQUIRED', 'Confirming possible duplicates needs the reviewToken of the dry run that showed them.');
      }
      const check = checkReviewToken(this.key, q.reviewToken, { sub: caller.id, file: fileSha256 });
      if (!check.ok) {
        throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_REVIEW_TOKEN', 'This review token is not valid for this file and this Administrator. Run a new dry run.', { reason: check.reason });
      }
      tokenSnap = { snap: check.payload.snap, exp: check.payload.exp };
    }

    const importId = randomUUID();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const ready = rows.filter((r) => r.fields);
        await lockSchoolDirectory(tx, 'shared');
        await lockSchoolKeys(tx, schoolLockPlan(ready.map((r) => ({ before: null, after: { ...r.fields!, isActive: true } }))));
        const result = await this.evaluate(tx, rows);
        if (result.errors.length) {
          throw new ImportRefused(new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'IMPORT_INVALID',
            'Nothing was imported: fix the rows listed and upload the file again.', result), 'IMPORT_INVALID',
            { totalRows: rows.length, failed: result.errors.length });
        }
        const flaggedRows = new Set(result.possibleDuplicates.map((d) => d.row));
        if (result.possibleDuplicates.length || tokenSnap) {
          const snap = snapshotDigest(reviewRows(result));
          if (!tokenSnap) {
            const t = this.token(caller, fileSha256, result);
            throw new ImportRefused(new AppError(HttpStatus.CONFLICT, 'POSSIBLE_DUPLICATES_UNCONFIRMED',
              'Some schools may already exist. Review the candidates, then import again with confirmPossibleDuplicates and this reviewToken.',
              { possibleDuplicates: result.possibleDuplicates, reviewToken: t.token, reviewExpiresAt: t.expiresAt.toISOString() }),
              'POSSIBLE_DUPLICATES_UNCONFIRMED', { totalRows: rows.length, possibleDuplicateRows: flaggedRows.size });
          }
          if (tokenSnap.exp <= this.now().getTime() || tokenSnap.snap !== snap) {
            const t = this.token(caller, fileSha256, result);
            throw new ImportRefused(new AppError(HttpStatus.CONFLICT, 'IMPORT_REVIEW_OUTDATED',
              'The possible duplicates changed (or the review expired) since your review. Review them again, then confirm with the new reviewToken.',
              { possibleDuplicates: result.possibleDuplicates, reviewToken: t.token, reviewExpiresAt: t.expiresAt.toISOString() }),
              'IMPORT_REVIEW_OUTDATED', { totalRows: rows.length, possibleDuplicateRows: flaggedRows.size });
          }
        }
        return this.createSchools(tx, ready, result, { importId, caller, ...meta });
      }, { timeout: 120_000, maxWait: 10_000 });
    } catch (err) {
      if (err instanceof ImportRefused) {
        await this.audit.log({
          actorId: caller.id, actorRole: caller.role, action: 'IMPORT_SCHOOLS_REFUSED', entity: 'School',
          metadata: { importId, ...meta, reason: err.reason, ...err.counts },
        });
        throw err.error;
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && /code/i.test(JSON.stringify(err.meta ?? {}))) {
        throw codeTaken();
      }
      throw err;
    }
  }

  /** The only place an import creates schools: every row, then every audit record, in the caller's transaction. */
  private async createSchools(
    tx: Prisma.TransactionClient, rows: PreparedRow[], result: Evaluation,
    ctx: { importId: string; caller: CallerCtx; fileName: string; fileSha256: string; format: string; totalRows: number },
  ) {
    const ids = rows.map(() => randomUUID());   // assigned up front: rows are mapped back by id (names repeat)
    const created = await tx.school.createManyAndReturn({
      data: rows.map((r, i) => newSchoolRecord(r.fields!, r.key!, ctx.caller.id, ids[i])),
      select: {
        id: true, name: true, code: true, countryCode: true, province: true, district: true, sector: true, cell: true, village: true,
        location: true, ownership: true, accommodation: true, source: true, isActive: true,
      },
    });
    const byId = new Map(created.map((s) => [s.id, s]));
    const flagged = new Map(result.possibleDuplicates.map((d) => [d.row, d.candidates]));
    const schools = rows.map((r, i) => ({ row: r.row, school: byId.get(ids[i])! }));
    await this.audit.logMany(schools.map(({ row, school }) => ({
      actorId: ctx.caller.id, actorRole: ctx.caller.role, action: 'CREATE_SCHOOL', entity: 'School', entityId: school.id,
      metadata: {
        via: 'IMPORT', importId: ctx.importId, fileName: ctx.fileName, fileSha256: ctx.fileSha256, row,
        school: schoolSnapshot(school),
        ...(flagged.has(row) && { confirmedPossibleDuplicate: true, possibleDuplicates: flagged.get(row) }),
      },
    })), tx);
    await this.audit.log({
      actorId: ctx.caller.id, actorRole: ctx.caller.role, action: 'IMPORT_SCHOOLS', entity: 'School',
      metadata: {
        importId: ctx.importId, fileName: ctx.fileName, fileSha256: ctx.fileSha256, format: ctx.format,
        totalRows: ctx.totalRows, created: schools.length, confirmedPossibleDuplicates: flagged.size,
      },
    }, tx);
    return {
      dryRun: false, importId: ctx.importId, totalRows: ctx.totalRows, created: schools.length,
      confirmedPossibleDuplicates: flagged.size,
      schools: schools.map(({ row, school }) => ({ row, id: school.id, name: school.name, code: school.code })),
    };
  }

  /** Row rules without the database: the single-create DTO, then the shared field rules; then duplicates within the file. */
  private async prepare(rows: ImportRow[]): Promise<PreparedRow[]> {
    const out: PreparedRow[] = [];
    for (const r of rows) {
      const errors = [...r.errors];
      if (errors.length) {   // unreadable cells (formula, date, error): report only those
        out.push({ row: r.row, fields: null, key: null, errors });
        continue;
      }
      const dto = plainToInstance(CreateSchoolDto, r.values);
      const problems = (await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).flatMap((e) => Object.values(e.constraints ?? {}));
      errors.push(...problems);
      let fields: SchoolFields | null = null;
      let key: string | null = null;
      if (errors.length === 0) {
        try {
          fields = validateSchoolFields({
            name: dto.name, countryCode: dto.countryCode ?? RWANDA, code: dto.code ?? null,
            province: dto.province ?? null, district: dto.district ?? null, sector: dto.sector ?? null,
            location: dto.location ?? null, ownership: dto.ownership ?? null,
            cell: dto.cell ?? null, village: dto.village ?? null, accommodation: dto.accommodation ?? null,
          });
          key = schoolNameKey(fields.name!);
        } catch (err) {
          errors.push((err as Error).message);
          fields = null;
        }
      }
      out.push({ row: r.row, fields: errors.length ? null : fields, key: errors.length ? null : key, errors });
    }
    // Duplicates inside the file are always errors (they cannot be confirmed): a repeated code, or
    // the same name in the same district (Rwanda) or country. The same name elsewhere is allowed.
    const firstCode = new Map<string, number>();
    const firstPlace = new Map<string, number>();
    for (const r of out) {
      if (!r.fields) continue;
      const f = r.fields;
      const place = f.countryCode === RWANDA ? `${r.key}|RW|${f.district}` : `${r.key}|${f.countryCode}`;
      const repeats: string[] = [];
      if (f.code && firstCode.has(f.code)) repeats.push(`code ${f.code} repeats row ${firstCode.get(f.code)}.`);
      if (firstPlace.has(place)) {
        repeats.push(`same name as row ${firstPlace.get(place)} in the same ${f.countryCode === RWANDA ? 'district' : 'country'} (a duplicate within this file).`);
      }
      if (repeats.length) {
        r.errors.push(...repeats);
        r.fields = null;
        continue;
      }
      if (f.code) firstCode.set(f.code, r.row);
      firstPlace.set(place, r.row);
    }
    return out;
  }

  /** Database checks — directory place, existing code, possible duplicates — loaded once for all rows. */
  private async evaluate(db: Db, rows: PreparedRow[]): Promise<Evaluation> {
    const ready = rows.filter((r) => r.fields);
    const rowErrors = new Map<number, string[]>(rows.filter((r) => r.errors.length).map((r) => [r.row, [...r.errors]]));
    const fail = (row: number, message: string) => rowErrors.set(row, [...(rowErrors.get(row) ?? []), message]);

    const places = new Map<string, { province: string | null; district: string | null; sector: string | null }>();
    for (const r of ready) {
      const f = r.fields!;
      if (f.countryCode === RWANDA) places.set(`${f.province}|${f.district}|${f.sector}`, { province: f.province, district: f.district, sector: f.sector });
    }
    const knownPlaces = places.size
      ? new Set((await db.school.findMany({
          where: { source: 'OFFICIAL_LIST', countryCode: RWANDA, OR: [...places.values()] },
          select: { province: true, district: true, sector: true }, distinct: ['province', 'district', 'sector'],
        })).map((p) => `${p.province}|${p.district}|${p.sector}`))
      : new Set<string>();
    const codes = ready.flatMap((r) => (r.fields!.code ? [r.fields!.code] : []));
    const takenCodes = new Set(codes.length ? (await db.school.findMany({ where: { code: { in: codes } }, select: { code: true } })).map((s) => s.code!) : []);
    const keys = [...new Set(ready.map((r) => r.key!))];
    const similar = keys.length
      ? await db.$queryRaw<Array<ReviewCandidate & { countryCode: string; key: string }>>`
          SELECT "id", "name", "code", "countryCode", "district", "isActive", COALESCE("nameKey", ${SQL_NAME_KEY}) AS "key"
            FROM "School" WHERE COALESCE("nameKey", ${SQL_NAME_KEY}) = ANY(${keys}) ORDER BY "name", "id"`
      : [];

    const possibleDuplicates: Evaluation['possibleDuplicates'] = [];
    for (const r of ready) {
      const f = r.fields!;
      if (f.countryCode === RWANDA && !knownPlaces.has(`${f.province}|${f.district}|${f.sector}`)) fail(r.row, directoryPlaceProblem(f).message);
      if (f.code && takenCodes.has(f.code)) fail(r.row, codeTaken().message);
      if (rowErrors.has(r.row)) continue;   // like single create: a refused school is not also checked for duplicates
      // The same rule as single create (findPossibleDuplicates): same key; Rwanda — same district or none; else same country.
      const candidates = similar
        .filter((c) => c.key === r.key && (f.countryCode === RWANDA
          ? c.countryCode === RWANDA && (c.district === f.district || c.district === null)
          : c.countryCode === f.countryCode))
        .slice(0, CANDIDATES_PER_ROW)
        .map(({ key: _k, ...c }) => c);
      if (candidates.length) possibleDuplicates.push({ row: r.row, name: f.name!, candidates });
    }
    return {
      errors: [...rowErrors].map(([row, errors]) => ({ row, errors })).sort((a, b) => a.row - b.row),
      possibleDuplicates,
    };
  }

  private token(caller: CallerCtx, fileSha256: string, result: Evaluation) {
    return signReviewToken(this.key, { sub: caller.id, file: fileSha256, snap: snapshotDigest(reviewRows(result)) }, this.now());
  }
}

function reviewRows(result: Evaluation): ReviewRow[] {
  return result.possibleDuplicates.map((d) => ({
    row: d.row, candidates: d.candidates.map((c) => ({ id: c.id, name: c.name, code: c.code, district: c.district, isActive: c.isActive })),
  }));
}
