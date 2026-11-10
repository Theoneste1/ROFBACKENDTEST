/**
 * Default programme membership for new accounts (plan §7.3; decision K6).
 *
 * While exactly one programme exists and it is Mathematics, every new STUDENT
 * and every new or approved MENTOR (Coach) gets a MANUAL membership in it,
 * written in the same transaction as the account (no half state). With no
 * programme, several, or one that is not Mathematics, nothing is added —
 * choosing a programme is later work (Phase 3/5). Other roles get none here.
 *
 * Membership grants no access: student access stays division-based and coach
 * access MentorAssignment-based. Idempotent: an existing (user, programme) row
 * is left exactly as it is (an ended membership is not revived).
 */
import type { Prisma } from '../generated/prisma/client.js';

const MEMBER_ROLES = ['STUDENT', 'MENTOR'];

export async function ensureDefaultMembership(
  tx: Prisma.TransactionClient,
  user: { id: string; role: string },
  addedById: string | null,
): Promise<{ disciplineId: string } | null> {
  if (!MEMBER_ROLES.includes(user.role)) return null;
  const disciplines = await tx.discipline.findMany({ select: { id: true, code: true }, take: 2 });
  if (disciplines.length !== 1 || disciplines[0].code !== 'MATHEMATICS') return null;
  const disciplineId = disciplines[0].id;
  await tx.programmeMembership.upsert({
    where:  { userId_disciplineId: { userId: user.id, disciplineId } },
    create: { userId: user.id, disciplineId, source: 'MANUAL', addedById },
    update: {},
  });
  return { disciplineId };
}
