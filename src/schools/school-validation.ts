/**
 * The rules a school record must satisfy — ONE implementation for single creation / editing
 * (AdminSchoolsService) and bulk import (SchoolImportService), so both accept and refuse exactly
 * the same schools with the same error codes and messages (PR D parity requirement).
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { assertDirectoryPlace, SQL_NAME_KEY } from './school-directory.js';
import { schoolKey } from './school-key.js';
import { codeProblems, RWANDA } from './school-rules.js';

type Tx = Prisma.TransactionClient;

/** Fields an edit may change, in audit order. */
export const EDITABLE = ['name', 'countryCode', 'code', 'province', 'district', 'sector', 'location', 'ownership'] as const;
export type Editable = (typeof EDITABLE)[number];
export type SchoolFields = Record<Editable, string | null>;

export interface DuplicateCandidate { id: string; name: string; code: string | null; countryCode: string; district: string | null; isActive: boolean }

/** The normalised name key (400 INVALID_SCHOOL_NAME when the name has no letters or digits). */
export function schoolNameKey(name: string): string {
  const key = schoolKey(name);
  if (!key) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SCHOOL_NAME', 'The school name must contain letters or digits.');
  return key;
}

/**
 * The resulting school's country rules. Rwanda: province, district and sector (official directory)
 * are required — except for a LEGACY school (entered before the directory), which may keep none
 * until a place or a code is given; then the place must be complete.
 */
export function validateSchoolFields(p: SchoolFields, opts: { legacy?: boolean } = {}): SchoolFields {
  const problems: string[] = [];
  if (p.countryCode === RWANDA) {
    const anyPlace = !!(p.province || p.district || p.sector);
    const placeRequired = !opts.legacy || anyPlace || !!p.code;
    if (placeRequired && (!p.province || !p.district || !p.sector)) {
      problems.push('A school in Rwanda needs province, district and sector (from the official directory).');
    }
    if (p.code) problems.push(...codeProblems(p.code, p.province));
  } else {
    if (p.code) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_CODE_RWANDA_ONLY', 'School codes are for schools in Rwanda.');
    }
    if (p.province || p.district || p.sector) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_DIRECTORY_RWANDA_ONLY',
        'Province, district and sector are Rwanda\'s directory; for another country give a location instead.');
    }
    if (!p.location) problems.push('A school outside Rwanda needs a location.');
  }
  if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SCHOOL', problems.join(' '), { problems });
  return p;
}

/** Rwanda: the province / district / sector must exist in the official directory (M8). */
export async function assertSchoolPlace(db: Pick<Tx, 'school'>, p: SchoolFields): Promise<void> {
  if (p.countryCode !== RWANDA || (!p.province && !p.district && !p.sector)) return;   // a legacy school without a place
  await assertDirectoryPlace(db, p);
}

export function nameTaken(schoolId?: string) {
  return new AppError(HttpStatus.CONFLICT, 'SCHOOL_NAME_TAKEN', 'A school with this name already exists.', schoolId && { schoolId });
}
export function codeTaken(schoolId?: string) {
  return new AppError(HttpStatus.CONFLICT, 'SCHOOL_CODE_TAKEN', 'A school with this code already exists.', schoolId && { schoolId });
}

export async function assertNameFree(db: Pick<Tx, 'school'>, name: string, exceptId: string | null): Promise<void> {
  const other = await db.school.findUnique({ where: { name }, select: { id: true } });
  if (other && other.id !== exceptId) throw nameTaken(other.id);
}

export async function assertCodeFree(db: Pick<Tx, 'school'>, code: string, exceptId: string | null): Promise<void> {
  const other = await db.school.findUnique({ where: { code }, select: { id: true } });
  if (other && other.id !== exceptId) throw codeTaken(other.id);
}

/**
 * Same normalised name — Rwanda: in the same district, or with no district recorded (legacy);
 * elsewhere: in the same country. Legacy rows without a nameKey are normalised in SQL.
 */
export function findPossibleDuplicates(db: Pick<Tx, '$queryRaw'>, key: string, p: Pick<SchoolFields, 'countryCode' | 'district'>, exceptId: string | null) {
  const place = p.countryCode === RWANDA
    ? Prisma.sql`"countryCode" = ${RWANDA} AND ("district" = ${p.district} OR "district" IS NULL)`
    : Prisma.sql`"countryCode" = ${p.countryCode}`;
  return db.$queryRaw<DuplicateCandidate[]>`
    SELECT "id", "name", "code", "countryCode", "district", "isActive" FROM "School"
     WHERE ${place}
       AND ("nameKey" = ${key} OR ("nameKey" IS NULL AND ${SQL_NAME_KEY} = ${key}))
       AND "id" <> ${exceptId ?? ''}
     ORDER BY "name", "id" LIMIT 20`;
}

/** The record written for a NEW school — single create and import alike: active, source ADMIN, its creator. */
export function newSchoolRecord(p: SchoolFields, nameKey: string, createdById: string): Prisma.SchoolUncheckedCreateInput {
  return {
    name: p.name!, nameKey, code: p.code, countryCode: p.countryCode!,
    province: p.province, district: p.district, sector: p.sector,
    location: p.location ?? `${p.sector}, ${p.district}`, ownership: p.ownership,
    source: 'ADMIN', isActive: true, createdById,
  };
}

/** A school's fields as recorded in an audit entry. */
export function schoolSnapshot(s: Record<string, unknown>) {
  return Object.fromEntries([...EDITABLE, 'source', 'isActive'].map((k) => [k, s[k] ?? null]));
}

export function possibleDuplicateError(candidates: DuplicateCandidate[]) {
  return new AppError(HttpStatus.CONFLICT, 'POSSIBLE_DUPLICATE',
    'A school with the same name already exists nearby. Use it, or repeat the request with confirmPossibleDuplicate: true.',
    { candidates });
}
