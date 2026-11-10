/**
 * PermissionService — resolves the caller's effective permissions, server-side,
 * on every request (P1-04; plan §4–§6). Nothing is stored in the JWT.
 *
 * Effective permissions = the role's default grants (ROLE_GRANTS). Individual
 * overrides join here in P1-09. A role the catalogue does not know has no
 * permissions (least privilege, as in P1-03).
 *
 * Administrators and Super Admins never hold grading or assignment-authoring
 * permissions (RS1, C7): those are removed from their effective set whatever
 * the source, so no inheritance or aggregation can add them.
 *
 * Permissions say WHAT a caller may do; WHERE (division, course × division,
 * programme, own records) is still enforced by the services (AccessService).
 */
import { Injectable } from '@nestjs/common';

import { AccessService } from '../common/access/access.service.js';
import { isCoach } from '../common/access/roles.js';
import type { ActiveOverride, AuthUser } from '../common/auth-user.js';
import { overrideRefusal } from './override-policy.js';
import {
  ADMINISTRATIVE_ROLES, ADMIN_PROHIBITED, PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, grantsForRole, permissionsFor,
  type AppRole, type Permission, type ScopeKind,
} from './permissions.js';

export interface PermissionSummary {
  role:        string;
  roleLabel:   string | null;
  /**
   * STUDENT, MENTOR, ADMIN: today's list, unchanged (decision A1).
   * TEACHER, HEAD_COACH, SUPER_ADMIN (no legacy list; storable after M1): their
   * effective catalogue permissions, in catalogue order. Unknown role: [].
   */
  permissions: readonly Permission[];
  /** courseDivisions: a coach's assignments. programmes: the programmes a Head Coach heads (P1-10); [] for everyone else. */
  scopes:      { courseDivisions: Array<{ courseId: string; divisionId: string }>; programmes: string[] };
  /** The caller's active individual overrides (P1-09). */
  overrides:   Array<{ permission: string; effect: 'GRANT' | 'DENY'; courseId: string | null; divisionId: string | null; expiresAt: Date | null }>;
}

/** Overrides that still apply at `now` (expiresAt is re-checked at every decision). */
function activeOverrides(user: AuthUser, now: Date): readonly ActiveOverride[] {
  return (user.overrides ?? []).filter((o) => o.expiresAt === null || o.expiresAt.getTime() > now.getTime());
}

@Injectable()
export class PermissionService {
  constructor(private readonly access: AccessService) {}

  /** The caller's stored role value — the only place this service reads it. */
  private roleOf(user: AuthUser): string {
    return user.role;
  }

  /**
   * Effective grants: permission → scope kind. Empty for an unknown role.
   * Role defaults, then the user's active individual overrides (P1-09): DENY
   * removes a permission; GRANT adds one only if the approved list allows it for
   * the role (never a never-grantable one), scoped to course × division — the
   * service then checks that scope. Each override's expiresAt is checked again
   * here, at the moment of the decision. No override ever applies to a
   * SUPER_ADMIN or an unknown role. RS1 is applied last, whatever the source.
   */
  effective(user: AuthUser, now: Date = new Date()): ReadonlyMap<Permission, ScopeKind> {
    const role = this.roleOf(user);
    const defaults = grantsForRole(role);
    const grants = new Map(Object.entries(defaults ?? {}) as Array<[Permission, ScopeKind]>);
    if (defaults && role !== 'SUPER_ADMIN') {
      for (const o of activeOverrides(user, now)) {
        if (overrideRefusal(role, o.permission, o.effect) !== null) continue;
        if (o.effect === 'DENY') grants.delete(o.permission as Permission);
        else grants.set(o.permission as Permission, 'courseDivision');
      }
    }
    if ((ADMINISTRATIVE_ROLES as readonly string[]).includes(role)) {
      for (const p of ADMIN_PROHIBITED) grants.delete(p);
    }
    return grants;
  }

  has(user: AuthUser, permission: Permission): boolean {
    return this.effective(user).has(permission);
  }

  scopeOf(user: AuthUser, permission: Permission): ScopeKind | null {
    return this.effective(user).get(permission) ?? null;
  }

  /** ADMIN or SUPER_ADMIN — used by the permission guard's grading rule (RS1). */
  isAdministrative(user: AuthUser): boolean {
    return (ADMINISTRATIVE_ROLES as readonly string[]).includes(this.roleOf(user));
  }

  /** GET /me/permissions. Existing fields unchanged for existing roles; roleLabel and scopes.courseDivisions are new (A2). */
  async describe(user: AuthUser): Promise<PermissionSummary> {
    const role = this.roleOf(user);
    const label = Object.hasOwn(ROLE_LABELS, role) ? ROLE_LABELS[role as AppRole] : null;
    const denied = new Set(this.deniedFor(user));
    return {
      role,
      roleLabel: label,
      permissions: this.listFor(user).filter((p) => !denied.has(p)),
      scopes: { courseDivisions: await this.courseDivisions(user), programmes: await this.access.headedProgrammes(user) },
      overrides: activeOverrides(user, new Date()).map((o) => ({
        permission: o.permission, effect: o.effect, courseId: o.courseId, divisionId: o.divisionId, expiresAt: o.expiresAt,
      })),
    };
  }

  /** Legacy list where one exists (A1); otherwise the effective grants (empty for an unknown role). */
  private listFor(user: AuthUser): readonly Permission[] {
    const role = this.roleOf(user);
    if (Object.hasOwn(ROLE_PERMISSIONS, role)) return permissionsFor(role as never);
    const held = this.effective(user);
    return PERMISSIONS.filter((p) => held.has(p));
  }

  /** Permissions removed by an applicable DENY override (none for SUPER_ADMIN). */
  private deniedFor(user: AuthUser): string[] {
    const role = this.roleOf(user);
    if (role === 'SUPER_ADMIN') return [];
    return activeOverrides(user, new Date())
      .filter((o) => o.effect === 'DENY' && overrideRefusal(role, o.permission, 'DENY') === null)
      .map((o) => o.permission);
  }

  /** A coach's active course × division assignments; nobody else has any. */
  private async courseDivisions(user: AuthUser) {
    if (isCoach(user)) {
      const scopes = await this.access.mentorScopes(user.id);
      return scopes.map((s) => ({ courseId: s.courseId, divisionId: s.divisionId }));
    }
    return [];
  }
}
