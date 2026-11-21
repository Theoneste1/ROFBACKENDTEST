/**
 * Default programme membership for new accounts (plan §7.3; decision K6).
 *
 * Every new STUDENT and every new or approved MENTOR (Coach) gets a MANUAL
 * membership in Mathematics (the programme with code MATHEMATICS), written in
 * the same transaction as the account (no half state). Without a Mathematics
 * programme nothing is added. Other roles get none here.
 *
 * G3 (Test Management plan, owner-approved 2026-11-19): the rule used to require
 * that Mathematics be the ONLY programme. Test Management adds the Physics and
 * Computing subjects (migration 20261220000100_tests_core), so the default is now
 * looked up by code: other programmes never stop it, and nobody is put into
 * Physics or Computing by default (choosing those stays an Administrator's or a
 * Head Coach's decision).
 *
 * Membership grants no access: student access stays division-based and coach
 * access MentorAssignment-based. Idempotent: an existing (user, programme) row
 * is left exactly as it is (an ended membership is not revived).
 */
import type { Prisma } from '../generated/prisma/client.js';

const MEMBER_ROLES = ['STUDENT', 'MENTOR'];
/** The default programme of new students and coaches (looked up by code, whatever other programmes exist). */
export const DEFAULT_PROGRAMME_CODE = 'MATHEMATICS';

export async function ensureDefaultMembership(
  tx: Prisma.TransactionClient,
  user: { id: string; role: string },
  addedById: string | null,
): Promise<{ disciplineId: string } | null> {
  if (!MEMBER_ROLES.includes(user.role)) return null;
  const mathematics = await tx.discipline.findUnique({ where: { code: DEFAULT_PROGRAMME_CODE }, select: { id: true } });
  if (!mathematics) return null;
  const disciplineId = mathematics.id;
  await tx.programmeMembership.upsert({
    where:  { userId_disciplineId: { userId: user.id, disciplineId } },
    create: { userId: user.id, disciplineId, source: 'MANUAL', addedById },
    update: {},
  });
  return { disciplineId };
}
