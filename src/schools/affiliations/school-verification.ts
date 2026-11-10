/**
 * A school shown next to a student, labelled with whether the student's membership of THAT
 * school is verified (PR #25 review): VERIFIED only when the student's current claim is
 * VERIFIED and for that exact school; anything else — pending, rejected, revoked, no claim,
 * or a claim for another school (e.g. an earlier year's enrolment) — is UNVERIFIED.
 */
export type SchoolVerification = 'VERIFIED' | 'UNVERIFIED';

/** Prisma select for a User's current claim (at most one, enforced by M10). */
export const CURRENT_CLAIM_SELECT = {
  where:  { supersededAt: null },
  take:   1,
  select: { schoolId: true, status: true },
} as const;

export function withVerification<S extends { id: string }>(
  school: S | null | undefined,
  claims: ReadonlyArray<{ schoolId: string | null; status: string }>,
): (S & { verification: SchoolVerification }) | null {
  if (!school) return null;
  const current = claims[0];
  const verified = current?.status === 'VERIFIED' && current.schoolId === school.id;
  return { ...school, verification: verified ? 'VERIFIED' : 'UNVERIFIED' };
}
