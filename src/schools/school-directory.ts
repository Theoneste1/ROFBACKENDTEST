/**
 * The official Rwanda school directory (M8) as a reference for places and names
 * (school administration PR B / PR C). One implementation for Administrator school creation,
 * registration and student claims, so a place is valid in exactly the same cases everywhere.
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { Prisma } from '../generated/prisma/client.js';
import { RWANDA } from './school-rules.js';

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
