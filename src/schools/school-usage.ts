/**
 * Using a school for something NEW — a student's claim, its verification, a Teacher assignment
 * (school administration PR B).
 *
 * The caller's transaction takes a SHARED row lock on each school (SELECT … FOR SHARE), held
 * until it commits, then checks the school is active. Deactivating a school updates that row,
 * which conflicts with FOR SHARE: a deactivation waits for every use already in progress, and
 * every use that starts after it commits sees the school inactive and is refused (409
 * SCHOOL_INACTIVE). So a claim or assignment is either made before the deactivation or refused —
 * never accepted afterwards.
 *
 * FOR SHARE, not FOR KEY SHARE (what a foreign-key check takes): KEY SHARE does not conflict
 * with updating a non-key column such as isActive, so it would not block a deactivation.
 * Several schools are locked one by one in ascending id order, so two operations can never wait
 * for each other in opposite orders (no deadlock).
 */
import { HttpStatus, NotFoundException } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import type { Prisma } from '../generated/prisma/client.js';

export function schoolInactive(schoolId: string) {
  return new AppError(HttpStatus.CONFLICT, 'SCHOOL_INACTIVE',
    'This school is inactive: it accepts no new students, claims or Teacher assignments.', { schoolId });
}

/** Lock each school (FOR SHARE, ascending id) and require it to exist and be active. */
export async function lockSchoolsForUse(tx: Prisma.TransactionClient, schoolIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(schoolIds)].sort()) {
    const [row] = await tx.$queryRaw<Array<{ isActive: boolean }>>`SELECT "isActive" FROM "School" WHERE "id" = ${id} FOR SHARE`;
    if (!row) throw new NotFoundException('School not found.');
    if (!row.isActive) throw schoolInactive(id);
  }
}
