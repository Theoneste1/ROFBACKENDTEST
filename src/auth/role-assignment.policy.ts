/**
 * The role allow-list (Phase 1 plan §4, safety rule 3; P1-05).
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
 *  - SUPER_ADMIN is never assignable or manageable through the user API (only
 *    by the approved bootstrap / Super Admin flows, P1-08);
 *  - TEACHER and HEAD_COACH are refused while TEACHERS_ENABLED /
 *    HEAD_COACHES_ENABLED are off (the default);
 *  - any other value, or an actor without the global permission, is refused.
 *
 * Programme-scoped management by Head Coaches (membership, coach invitations →
 * pending approval) comes with P1-10; until then only global grants count.
 */
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AuthUser, CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { PermissionService } from './permission.service.js';
import type { AppRole, Permission } from './permissions.js';

/** The permission needed to manage accounts of each role; null = never through the user API. */
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

@Injectable()
export class RoleAssignmentPolicy {
  constructor(
    private readonly permissions: PermissionService,
    private readonly config: ConfigService,
  ) {}

  /** The actor may give an account this role (create, invite, import, role change). */
  assertCanAssign(actor: CallerCtx, role: string): void {
    if (!this.mayManage(actor, role)) throw notAssignable(role);
    const flag = Object.hasOwn(FLAGGED, role) ? FLAGGED[role as AppRole] : undefined;
    if (flag && this.config.get<string>(flag.env) !== 'true') {
      throw new AppError(HttpStatus.FORBIDDEN, flag.code, flag.message, { role });
    }
  }

  /** The actor may act on an account that currently holds this role. */
  assertCanManage(actor: CallerCtx, currentRole: string): void {
    if (!this.mayManage(actor, currentRole)) {
      throw new AppError(
        HttpStatus.FORBIDDEN, 'ROLE_NOT_ASSIGNABLE',
        'You cannot manage accounts with this role.', { role: currentRole },
      );
    }
  }

  /** Known role, manageable through the user API, and the actor holds the permission globally. */
  private mayManage(actor: CallerCtx, role: string): boolean {
    const permission = Object.hasOwn(MANAGE_PERMISSION, role) ? MANAGE_PERMISSION[role as AppRole] : null;
    if (!permission) return false;
    return this.permissions.scopeOf(actor as AuthUser, permission) === 'global';
  }
}

function notAssignable(role: string) {
  return new AppError(HttpStatus.FORBIDDEN, 'ROLE_NOT_ASSIGNABLE', 'This role cannot be assigned.', { role });
}
