/**
 * The official Rwanda school directory (M8) as a reference for places and names
 * (school administration PR B / PR C). One implementation for Administrator school creation,
 * registration and student claims, so a place is valid in exactly the same cases everywhere.
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { RWANDA } from './school-rules.js';
import { schoolInactive } from './school-usage.js';

type Tx = Prisma.TransactionClient;
export interface DirectoryPlace { province: string | null; district: string | null; sector: string | null }

/** The same normalisation as schoolKey(), in SQL (as in M8), for legacy rows without a nameKey. */
export const SQL_NAME_KEY = Prisma.sql`trim(regexp_replace(translate(lower("name"), 'àáâäãåçèéêëìíîïñòóôöõùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'), '[^a-z0-9]+', ' ', 'g'))`;

/** The error for a place that is not in the official directory (one wording everywhere). */
export function directoryPlaceProblem(p: DirectoryPlace) {
  return new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL_LOCATION',
    `${p.sector}, ${p.district}, ${p.province} is not a place in the official directory.`,
    { province: p.province, district: p.district, sector: p.sector });
}

/** Province / district / sector must be one combination of the official directory (400 UNKNOWN_SCHOOL_LOCATION). */
export async function assertDirectoryPlace(db: Pick<Tx, 'school'>, p: DirectoryPlace): Promise<void> {
  const known = await db.school.findFirst({
    where: { source: 'OFFICIAL_LIST', countryCode: RWANDA, province: p.province, district: p.district, sector: p.sector },
    select: { id: true },
  });
  if (!known) throw directoryPlaceProblem(p);
}

/**
 * The one ACTIVE official Rwandan school with this normalised name in exactly this sector, or null
 * (none, or several). Used for "My school is not listed": an exact unique match is linked — the
 * claim stays PENDING.
 */
export async function uniqueOfficialSchoolInPlace(db: Pick<Tx, 'school'>, nameKey: string, p: DirectoryPlace) {
  const matches = await db.school.findMany({
    where: {
      source: 'OFFICIAL_LIST', countryCode: RWANDA, isActive: true, code: { not: null }, nameKey,
      province: p.province, district: p.district, sector: p.sector,
    },
    select: { id: true }, take: 2,
  });
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Owner decision 2026-11-14: schools without an official code are offered by the public search
 * (name and place) and chosen by their internal id; no official code is ever invented for them.
 * The public directory is every ACTIVE Rwandan school with an official code, plus the schools without
 * one that an administrator entered (source ADMIN: official name and place). Free-text LEGACY schools
 * entered before the directory (no code, unvetted names) are never offered publicly; Administrators
 * still match claims to them.
 */
export const PUBLIC_SCHOOL_WHERE = {
  countryCode: RWANDA, isActive: true, NOT: { code: null, source: 'LEGACY' },
} as const satisfies Prisma.SchoolWhereInput;

/**
 * Schools a Teacher may name (owner decision 2026-11-14): active Rwandan schools with an official
 * code, or without one when an administrator created the school (source ADMIN) AND verified it
 * (lastVerifiedAt, POST /admin/schools/:id/verify). Never an invented code: these are chosen by id.
 */
export const TEACHER_SCHOOL_WHERE = {
  countryCode: RWANDA, isActive: true,
  OR: [{ code: { not: null } }, { source: 'ADMIN', lastVerifiedAt: { not: null } }],
} as const satisfies Prisma.SchoolWhereInput;

/**
 * The school a registration or a student claim names by its internal id (`schoolId`, from
 * GET /schools/search) — a Rwandan school the public search offers (official code, or entered by an
 * administrator). Unknown, not in the Rwandan directory, or a LEGACY free-text school without a code:
 * 400 UNKNOWN_SCHOOL; inactive: 409 SCHOOL_INACTIVE. The claim
 * re-checks the school under a row lock (school-usage.ts).
 */
export async function directorySchoolById(db: Pick<Tx, 'school'>, schoolId: string) {
  const school = await db.school.findUnique({
    where: { id: schoolId }, select: { id: true, code: true, name: true, isActive: true, countryCode: true, source: true },
  });
  if (!school || school.countryCode !== RWANDA || (school.code === null && school.source === 'LEGACY')) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL', 'No school in the list has this id. Choose your school from the list.', { schoolId });
  }
  if (!school.isActive) throw schoolInactive(school.id);
  return { id: school.id, code: school.code, name: school.name };
}
