/**
 * Student school-claim policy (school administration PR C; owner decisions 2026-11-11).
 * Pure functions — no database — so every rule is unit-tested at its boundaries.
 *
 *   classifyClaimRequest  the body of POST /me/school-affiliation is exactly one kind, checked in
 *                         this order (the first rule that applies decides the response):
 *                           1. schoolCode → a Rwandan school by code (country other than RW: 400
 *                              SCHOOL_CODE_RWANDA_ONLY; any name / place field too: 400 VALIDATION_FAILED)
 *                           2. country absent or RW → "not listed": schoolName + province + district +
 *                              sector, all required (400 VALIDATION_FAILED otherwise)
 *                           3. another country → international: schoolName required; any place field:
 *                              400 SCHOOL_DIRECTORY_RWANDA_ONLY
 *   sameSchool            two claims name the same school: both linked → the same schoolId; otherwise
 *                         the same normalised name and country, and each of province / district /
 *                         sector equal wherever BOTH claims have it (a field missing on either side is
 *                         ignored, so leaving out the place cannot escape a cooldown)
 *   limit                 at most CLAIM_REQUESTS_PER_WINDOW student-created claims (STUDENT_REQUEST)
 *                         in any rolling CLAIM_WINDOW_MS
 *   cooldown              CLAIM_COOLDOWN_MS after the latest rejection / revocation of the SAME school
 *                         (any of the student's claims, ended ones included); other schools unaffected
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../../common/errors/app-error.js';
import { schoolKey } from '../school-key.js';
import { RWANDA } from '../school-rules.js';

export const CLAIM_REQUESTS_PER_WINDOW = 3;
export const CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CLAIM_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClaimRequestBody {
  schoolCode?:     string;
  schoolName?:     string;
  country?:        string;
  schoolProvince?: string;
  schoolDistrict?: string;
  schoolSector?:   string;
}

export type ClaimRequest =
  | { kind: 'CODE'; schoolCode: string }
  | { kind: 'NOT_LISTED'; schoolName: string; province: string; district: string; sector: string }
  | { kind: 'INTERNATIONAL'; schoolName: string; country: string };

const bad = (code: string, message: string) => new AppError(HttpStatus.BAD_REQUEST, code, message);

export function classifyClaimRequest(b: ClaimRequestBody): ClaimRequest {
  const country = b.country ?? RWANDA;
  const place = [b.schoolProvince, b.schoolDistrict, b.schoolSector];
  const anyPlace = place.some((x) => x !== undefined);
  if (b.schoolCode !== undefined) {
    if (country !== RWANDA) throw bad('SCHOOL_CODE_RWANDA_ONLY', 'School codes are for schools in Rwanda.');
    if (b.schoolName !== undefined || anyPlace) {
      throw bad('VALIDATION_FAILED', 'Send either schoolCode, or schoolName with its place (Rwanda) or country — not both.');
    }
    return { kind: 'CODE', schoolCode: b.schoolCode };
  }
  if (country === RWANDA) {
    if (b.schoolName === undefined || place.some((x) => x === undefined)) {
      throw bad('VALIDATION_FAILED',
        'For a school in Rwanda send schoolCode, or — if it is not listed — schoolName with schoolProvince, schoolDistrict and schoolSector.');
    }
    return { kind: 'NOT_LISTED', schoolName: b.schoolName, province: b.schoolProvince!, district: b.schoolDistrict!, sector: b.schoolSector! };
  }
  if (anyPlace) {
    throw bad('SCHOOL_DIRECTORY_RWANDA_ONLY', 'Province, district and sector are Rwanda\'s directory; for another country send schoolName only.');
  }
  if (b.schoolName === undefined) throw bad('VALIDATION_FAILED', 'schoolName is required for a school outside Rwanda.');
  return { kind: 'INTERNATIONAL', schoolName: b.schoolName, country };
}

export interface ClaimIdentity {
  schoolId: string | null;
  name:     string | null;
  country:  string | null;
  province: string | null;
  district: string | null;
  sector:   string | null;
}

export function sameSchool(a: ClaimIdentity, b: ClaimIdentity): boolean {
  if (a.schoolId && b.schoolId) return a.schoolId === b.schoolId;
  if (!a.name || !b.name) return false;
  const ka = schoolKey(a.name), kb = schoolKey(b.name);
  if (!ka || ka !== kb) return false;
  if ((a.country ?? RWANDA) !== (b.country ?? RWANDA)) return false;
  return (['province', 'district', 'sector'] as const).every((k) => !a[k] || !b[k] || a[k] === b[k]);
}

/** When the next student request is allowed (null: now). `createdAts`: the student's own STUDENT_REQUEST claims. */
export function limitRetryAfter(createdAts: readonly Date[], now: Date): Date | null {
  const inWindow = createdAts.filter((t) => now.getTime() - t.getTime() < CLAIM_WINDOW_MS).sort((x, y) => x.getTime() - y.getTime());
  if (inWindow.length < CLAIM_REQUESTS_PER_WINDOW) return null;
  // The window frees a slot when the oldest request in it is CLAIM_WINDOW_MS old.
  return new Date(inWindow[inWindow.length - CLAIM_REQUESTS_PER_WINDOW].getTime() + CLAIM_WINDOW_MS);
}

/** When the cooldown for a school ends (null: none). `decisions`: rejection / revocation times for that school. */
export function cooldownUntil(decisions: readonly Date[], now: Date): Date | null {
  if (decisions.length === 0) return null;
  const until = new Date(Math.max(...decisions.map((d) => d.getTime())) + CLAIM_COOLDOWN_MS);
  return until.getTime() > now.getTime() ? until : null;
}
