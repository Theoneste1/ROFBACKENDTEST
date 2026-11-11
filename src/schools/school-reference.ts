/**
 * A school named in an Administrator request — create or edit a user, an invitation, a CSV
 * import row (school administration PR B). It must be an EXISTING school, identified by
 * `schoolId` or `schoolCode` (Rwandan schools only); these paths never create a school.
 *
 *   nothing given                → no school
 *   schoolName alone             → 400 SCHOOL_REFERENCE_REQUIRED (never matched, never created)
 *   schoolId / schoolCode        → that school (404 / 400 UNKNOWN_SCHOOL_CODE when none)
 *   both                         → must be the same school (400 SCHOOL_REFERENCE_MISMATCH)
 *   schoolName with an id / code → must be that school's name after normalisation (schoolKey:
 *                                  case, accents, punctuation and spacing ignored), otherwise
 *                                  400 SCHOOL_NAME_MISMATCH — a student is never placed in a
 *                                  different school than the one the request names
 *   requireActive                → an inactive school is refused (409 SCHOOL_INACTIVE)
 *
 * This is the early, readable check; the claim itself re-checks the school under a row lock
 * (school-usage.ts), so a deactivation in between still wins.
 */
import { HttpStatus, NotFoundException } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';
import { schoolKey } from './school-key.js';
import { RWANDA } from './school-rules.js';
import { schoolInactive } from './school-usage.js';

export interface SchoolReference {
  schoolId?:   string | null;
  schoolCode?: string | null;
  schoolName?: string | null;
}

export interface ResolvedSchool { id: string; code: string | null; name: string; isActive: boolean }

type SchoolReader = { school: Pick<Prisma.TransactionClient['school'], 'findUnique' | 'findFirst'> };

const SELECT = { id: true, code: true, name: true, isActive: true } as const;

export async function resolveSchoolReference(
  db: SchoolReader, ref: SchoolReference, opts: { requireActive: boolean },
): Promise<ResolvedSchool | null> {
  const name = ref.schoolName?.trim() || null;
  if (!ref.schoolId && !ref.schoolCode) {
    if (name) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_REFERENCE_REQUIRED',
        `School "${name}" was given by name only. Give the school's schoolCode (or schoolId); ` +
        'schools are never created from a name here — an Administrator creates them under Schools.');
    }
    return null;
  }

  const byId = ref.schoolId ? await db.school.findUnique({ where: { id: ref.schoolId }, select: SELECT }) : null;
  if (ref.schoolId && !byId) throw new NotFoundException('School not found.');
  const byCode = ref.schoolCode
    ? await db.school.findFirst({ where: { code: ref.schoolCode, countryCode: RWANDA }, select: SELECT })
    : null;
  if (ref.schoolCode && !byCode) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL_CODE', `No school has code ${ref.schoolCode}.`, { schoolCode: ref.schoolCode });
  }
  if (byId && byCode && byId.id !== byCode.id) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_REFERENCE_MISMATCH',
      `schoolId and schoolCode name different schools ("${byId.name}" and "${byCode.name}").`,
      { schoolId: byId.id, schoolCode: ref.schoolCode });
  }
  const school = (byId ?? byCode)!;

  if (name && schoolKey(name) !== schoolKey(school.name)) {
    const label = school.code ? `code ${school.code}` : `id ${school.id}`;
    throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_NAME_MISMATCH',
      `School name "${name}" does not match the school with ${label} ("${school.name}").`,
      { schoolName: name, school: { id: school.id, code: school.code, name: school.name } });
  }
  if (opts.requireActive && !school.isActive) throw schoolInactive(school.id);
  return school;
}
