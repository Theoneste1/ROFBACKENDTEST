/**
 * Locks for school records (school administration PR D; owner-approved 2026-11-11).
 *
 * Every operation that creates or changes a school's name, code, district, country or active
 * flag — single create, bulk import, PATCH, activate / deactivate — takes, in this order:
 *
 *   1. the existing school's row lock (FOR UPDATE), when it edits an existing school
 *      (taken by the caller before this plan);
 *   2. name locks (namespace 4213) on normalised name keys — sorted, each once;
 *   3. code locks (namespace 4214) on school codes — sorted, each once.
 *
 * All paths take names before codes and each group in ascending order, and only PATCH /
 * setActive hold an existing school's row (taken first; create and import lock no existing
 * row), so two operations never wait for each other in opposite orders.
 *
 *   create / import row    the new name's key; the new code (if any)
 *   PATCH, name changed    the old and the new key
 *   PATCH, district / country / code / active changed
 *                          the school's key (these are what duplicate detection and an import's
 *                          review snapshot read under that lock)
 *   PATCH, code changed    the old code (if any) and the new code
 *   only location / province / sector / ownership
 *                          nothing (no unnecessary lock)
 */
import type { Prisma } from '../generated/prisma/client.js';
import { schoolKey } from './school-key.js';

export const SCHOOL_NAME_LOCK_NAMESPACE = 4213;
export const SCHOOL_CODE_LOCK_NAMESPACE = 4214;

/** The fields of a school that the locks protect. */
export interface LockableSchool {
  name:        string | null;
  code:        string | null;
  countryCode: string | null;
  district:    string | null;
  isActive:    boolean | null;
}

export interface SchoolLockPlan { nameKeys: string[]; codes: string[] }

/** The locks for a set of changes (`before` null: a new school). Sorted, de-duplicated. */
export function schoolLockPlan(changes: ReadonlyArray<{ before: LockableSchool | null; after: LockableSchool }>): SchoolLockPlan {
  const names = new Set<string>();
  const codes = new Set<string>();
  const addName = (name: string | null) => { const k = name ? schoolKey(name) : ''; if (k) names.add(k); };
  const addCode = (code: string | null) => { if (code) codes.add(code); };
  for (const { before, after } of changes) {
    if (!before) {
      addName(after.name);
      addCode(after.code);
      continue;
    }
    const nameChanged = before.name !== after.name;
    const codeChanged = before.code !== after.code;
    const snapshotChanged = nameChanged || codeChanged || before.district !== after.district
      || before.countryCode !== after.countryCode || before.isActive !== after.isActive;
    if (snapshotChanged) addName(before.name);
    if (nameChanged) addName(after.name);
    if (codeChanged) { addCode(before.code); addCode(after.code); }
  }
  return { nameKeys: [...names].sort(), codes: [...codes].sort() };
}

/** Take the plan's locks inside the caller's transaction: every name, then every code, in order. */
export async function lockSchoolKeys(tx: Prisma.TransactionClient, plan: SchoolLockPlan): Promise<void> {
  for (const key of plan.nameKeys) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SCHOOL_NAME_LOCK_NAMESPACE}::int, hashtext(${key}))::text`;
  }
  for (const code of plan.codes) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${SCHOOL_CODE_LOCK_NAMESPACE}::int, hashtext(${code}))::text`;
  }
}
