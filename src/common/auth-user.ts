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
  /**
   * The user's active individual permission overrides (P1-09), loaded with the
   * user on every request: not revoked, and not expired when loaded. Expiry is
   * checked again at each authorization decision (PermissionService).
   */
  overrides?: readonly ActiveOverride[];
  /**
   * A STUDENT without a date of birth (created by an Administrator, invited or imported): until they give it, only
   * routes marked @AllowedBeforeDateOfBirth answer (DateOfBirthGuard, owner decision 9.3). Absent otherwise.
   */
  dateOfBirthRequired?: true;
  /**
   * Present only on a request made with a "view as" token (src/auth/view-as): this AuthUser is the VIEWED user (so
   * every page shows exactly their data and permissions); `viewAs` names the administrator who is viewing. Every
   * non-GET request is refused (ViewAsReadOnlyGuard) and the database refuses writes.
   */
  viewAs?: ViewAsInfo;
}

export interface ViewAsPerson {
  id:   string;
  name: string;
  role: string;
}

export interface ViewAsInfo {
  sessionId: string;
  actor:     ViewAsPerson;
  target:    ViewAsPerson;
  /** When the viewing token stops working (30 minutes after it was issued). */
  expiresAt: Date;
}

export interface ActiveOverride {
  id:         string;
  permission: string;
  effect:     'GRANT' | 'DENY';
  courseId:   string | null;
  divisionId: string | null;
  expiresAt:  Date | null;
}

/**
 * Minimal caller identity threaded from controllers into services.
 * `AuthUser` satisfies this interface.
 */
export interface CallerCtx {
  id:   string;
  role: string;
}
