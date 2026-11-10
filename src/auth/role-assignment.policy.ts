/**
 * The role allow-list (Phase 1 plan §4, safety rule 3; P1-05, extended in P1-08).
 *
 * One rule for every path that creates an account or gives it a role — create,
 * invite, CSV import, register/admin, PATCH /admin/users/:id — and for every
 * admin action on an existing account (edit, status, delete, re-send
 * invitation, password-reset link):
 *
 *  - assigning role R needs the global "manage R accounts" permission
 *    (STUDENT → users.manageStudents, MENTOR → users.manageCoaches,
 *    TEACHER → users.manageTeachers, HEAD_COACH → users.manageHeadCoaches,
 *    ADMIN → users.manageAdmins);
 *  - acting on an account needs the same permission for its CURRENT role
 *    ("allowed to manage both the current and the new role");
 *  - SUPER_ADMIN accounts are managed by a SUPER_ADMIN only, and the role is
 *    never given on creation — only by a Super Admin's role change (promotion,
 *    with step-up; UsersService) or the operator commands (bootstrap /
 *    break-glass, P1-08);
 *  - SUPER_ADMIN_BOUNDARY_ENABLED (plan §8.3): when "true" and at least one
 *    active SUPER_ADMIN exists, an ADMIN can no longer manage ADMIN accounts;
 *    with no active SUPER_ADMIN it is not enforced (fail-safe, error logged);
 *  - TEACHER and HEAD_COACH are refused while TEACHERS_ENABLED /
 *    HEAD_COACHES_ENABLED are off (the default);
 *  - any other value, or an actor without the global permission, is refused.
 *
 * Programme-scoped management by Head Coaches (membership, coach invitations →
 * pending approval) comes with P1-10; until then only global grants count.
 */
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthUser, CallerCtx } from '../common/auth-user.js';
import { isSuperAdmin } from '../common/access/roles.js';
import { AppError } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PermissionService } from './permission.service.js';
import type { AppRole, Permission } from './permissions.js';

/**
 * The permission needed to manage accounts of each role. SUPER_ADMIN has no
 * permission entry: only a SUPER_ADMIN actor manages those accounts.
 */
export const MANAGE_PERMISSION: Readonly<Record<AppRole, Permission | null>> = {
  STUDENT:     'users.manageStudents',
  MENTOR:      'users.manageCoaches',
  TEACHER:     'users.manageTeachers',
  HEAD_COACH:  'users.manageHeadCoaches',
  ADMIN:       'users.manageAdmins',
  SUPER_ADMIN: null,
};

/** Roles behind a feature flag, and the flag's refusal. */
const FLAGGED: Readonly<Partial<Record<AppRole, { env: string; code: string; message: string }>>> = {
  TEACHER:    { env: 'TEACHERS_ENABLED',     code: 'TEACHERS_DISABLED',     message: 'The Teacher role is not enabled yet.' },
  HEAD_COACH: { env: 'HEAD_COACHES_ENABLED', code: 'HEAD_COACHES_DISABLED', message: 'The Head Coach role is not enabled yet.' },
};

/** How a role is being given: on a new account, or by changing an existing account's role. */
export type AssignVia = 'create' | 'roleChange';

@Injectable()
export class RoleAssignmentPolicy {
  private readonly logger = new Logger(RoleAssignmentPolicy.name);

  constructor(
    private readonly permissions: PermissionService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** The actor may give an account this role. SUPER_ADMIN only by a Super Admin's role change. */
  async assertCanAssign(actor: CallerCtx, role: string, via: AssignVia = 'create'): Promise<void> {
    if (role === 'SUPER_ADMIN' && via === 'create') throw notAssignable(role);
    if (!(await this.mayManage(actor, role))) throw notAssignable(role);
    const flag = Object.hasOwn(FLAGGED, role) ? FLAGGED[role as AppRole] : undefined;
    if (flag && this.config.get<string>(flag.env) !== 'true') {
      throw new AppError(HttpStatus.FORBIDDEN, flag.code, flag.message, { role });
    }
  }

  /** The actor may act on an account that currently holds this role. */
  async assertCanManage(actor: CallerCtx, currentRole: string): Promise<void> {
    if (!(await this.mayManage(actor, currentRole))) {
      throw new AppError(
        HttpStatus.FORBIDDEN, 'ROLE_NOT_ASSIGNABLE',
        'You cannot manage accounts with this role.', { role: currentRole },
      );
    }
  }

  private async mayManage(actor: CallerCtx, role: string): Promise<boolean> {
    if (role === 'SUPER_ADMIN') return isSuperAdmin(actor);
    const permission = Object.hasOwn(MANAGE_PERMISSION, role) ? MANAGE_PERMISSION[role as AppRole] : null;
    if (!permission) return false;
    if (this.permissions.scopeOf(actor as AuthUser, permission) !== 'global') return false;
    if (role === 'ADMIN' && !isSuperAdmin(actor) && (await this.boundaryEnforced())) return false;
    return true;
  }

  /** SUPER_ADMIN_BOUNDARY_ENABLED is on AND an active Super Admin exists (otherwise fail-safe: not enforced). */
  private async boundaryEnforced(): Promise<boolean> {
    if (this.config.get<string>('SUPER_ADMIN_BOUNDARY_ENABLED') !== 'true') return false;
    const active = await this.prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
    if (active === 0) {
      this.logger.error('SUPER_ADMIN_BOUNDARY_ENABLED is on but no active Super Admin exists — boundary NOT enforced.');
      return false;
    }
    return true;
  }
}

function notAssignable(role: string) {
  return new AppError(HttpStatus.FORBIDDEN, 'ROLE_NOT_ASSIGNABLE', 'This role cannot be assigned.', { role });
}
