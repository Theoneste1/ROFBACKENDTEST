/**
 * Who may mark a subject's tests (owner 2026-11-23): a COACH (MENTOR, ACTIVE account checked by the callers) who
 *   - holds an ACTIVE marker authorisation for the subject (MarkerAuthorization: granted by an Administrator or the
 *     subject's Head Coach), OR
 *   - is an ACTIVE member of the subject's programme — every coach of a programme marks its tests by default,
 * AND has no ACTIVE MARKING restriction for the subject (CoachProgrammeRestriction: taken away by an Administrator or the
 * programme's Head Coach, with a reason) — a restriction blocks both paths, so "removed" always means removed.
 * Marking stays blind and still needs the submission to be ASSIGNED to the coach; this decides only who may be.
 */
import type { Prisma } from '../generated/prisma/client.js';

type Db = Pick<Prisma.TransactionClient, 'user'>;

/** `User` filter: coaches who may mark this subject. */
export function mayMarkWhere(disciplineId: string): Prisma.UserWhereInput {
  return {
    role: 'MENTOR',
    OR: [
      { markerAuthorizations: { some: { disciplineId, revokedAt: null } } },
      { programmeMemberships: { some: { disciplineId, isActive: true } } },
    ],
    coachRestrictions: { none: { disciplineId, capability: 'MARKING', liftedAt: null } },
  };
}

/** The subjects this coach may mark now (empty for anyone who is not a Coach). */
export async function markingSubjectsOf(db: Db, coachId: string): Promise<string[]> {
  const u = await db.user.findUnique({
    where: { id: coachId },
    select: {
      role: true,
      markerAuthorizations: { where: { revokedAt: null }, select: { disciplineId: true } },
      programmeMemberships: { where: { isActive: true }, select: { disciplineId: true } },
      coachRestrictions: { where: { capability: 'MARKING', liftedAt: null }, select: { disciplineId: true } },
    },
  });
  if (!u || u.role !== 'MENTOR') return [];
  const blocked = new Set(u.coachRestrictions.map((r) => r.disciplineId));
  return [...new Set([...u.markerAuthorizations, ...u.programmeMemberships].map((x) => x.disciplineId))].filter((d) => !blocked.has(d)).sort();
}

/** Whether this coach may mark this subject now. */
export async function mayMark(db: Db, coachId: string, disciplineId: string): Promise<boolean> {
  return (await db.user.count({ where: { AND: [{ id: coachId }, mayMarkWhere(disciplineId)] } })) > 0;
}
