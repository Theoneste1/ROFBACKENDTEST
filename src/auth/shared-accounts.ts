/**
 * Shared administrator accounts (P1-08 hardening). The seed creates one shared ADMIN account —
 * `admin`, or the username in SEED_ADMIN_USERNAME — whose password is known to more than one
 * person. Such an account must never become a Super Administrator — by an in-app promotion
 * (RoleAssignmentPolicy.assertSharedAccountRules), the bootstrap or break-glass promotion — and it
 * keeps its username, so it cannot be renamed out of the rule. Refusal code: SHARED_ACCOUNT_REFUSED.
 * Pure; unit-tested.
 */

/** The username the seed always uses when SEED_ADMIN_USERNAME is not set (prisma/seed.ts). */
export const DEFAULT_SEED_ADMIN_USERNAME = 'admin';

/**
 * The usernames of shared seeded administrator accounts: always `admin`, plus SEED_ADMIN_USERNAME
 * when it is configured. Compared case-insensitively and without surrounding spaces (usernames are
 * stored in lower case).
 */
export function sharedAdminUsernames(seedAdminUsername: string | undefined | null): Set<string> {
  const names = new Set([DEFAULT_SEED_ADMIN_USERNAME]);
  const configured = seedAdminUsername?.trim().toLowerCase();
  if (configured) names.add(configured);
  return names;
}

export function isSharedAdminAccount(username: string, seedAdminUsername: string | undefined | null): boolean {
  return sharedAdminUsernames(seedAdminUsername).has(username.trim().toLowerCase());
}

/**
 * Transaction-scoped PostgreSQL advisory lock key that serialises every operator promotion to
 * Super Administrator (bootstrap and break-glass promote-admin): a second concurrent run waits for
 * the first to commit, then sees its Super Admin and is refused (SUPER_ADMIN_EXISTS). Any constant
 * works as long as nothing else uses it; this one is unique in the code base.
 */
export const SUPER_ADMIN_PROMOTION_LOCK = 815_2026_0001n;
