import type { GradeLevel, Role } from '../generated/prisma/client.js';

/**
 * The authenticated user attached to every request by JwtStrategy.
 *
 * It is loaded from the database on each request, so role changes,
 * suspensions and division moves take effect immediately.
 */
export interface AuthUser {
  id:         string;
  username:   string;
  role:       Role;
  /** Students only. */
  divisionId: string | null;
  /** Students only. */
  gradeLevel: GradeLevel | null;
  /** JWT id of the presented access token (used by logout). */
  jti?:       string;
  /** Access-token expiry (seconds since epoch). */
  exp?:       number;
}

/**
 * Minimal caller identity threaded from controllers into services.
 * `AuthUser` satisfies this interface.
 */
export interface CallerCtx {
  id:   string;
  role: string;
}
