import type { Prisma } from '../generated/prisma/client.js';

/** The select for a user's active individual overrides (P1-09), read fresh on every request (JwtStrategy, view as). */
export function activeOverridesSelect(now: Date = new Date()) {
  return {
    where:  { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true, permission: true, effect: true, courseId: true, divisionId: true, expiresAt: true } as const,
  } satisfies Prisma.User$permissionOverridesArgs;
}
