import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AppError } from '../../common/errors/app-error.js';
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator.js';
import { PermissionService } from '../permission.service.js';
import { ADMIN_PROHIBITED, PERMISSIONS, type Permission } from '../permissions.js';

/**
 * Permission guard (registered globally, after JwtAuthGuard and RolesGuard).
 *
 *  - No @RequirePermission on the route → does nothing (every route in P1-04;
 *    access stays with @Roles / @Authenticated / @Public).
 *  - @RequirePermission('x.y') → the caller must hold the permission, else 403
 *    PERMISSION_REQUIRED (fails closed, including without a user).
 *  - Metadata present but not a known permission ('' / null / unknown name /
 *    non-string) → 403 for every caller, before any grant is looked at.
 *  - Grading and assignment authoring are refused to ADMIN and SUPER_ADMIN
 *    whatever their grants (RS1, defence in depth).
 *
 * Permission checks never replace record-level or scope checks in services.
 *
 * @Public is deliberately NOT a bypass here (a change from plan v5.2 §4.3 step 2,
 * agreed in review). @Public together with @RequirePermission is a contradictory
 * declaration and is rejected by route-declarations.spec.ts. If such a route ever
 * slipped through, JwtAuthGuard would skip authentication (no user) and this
 * guard would refuse it — failing closed instead of opening the route.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const required: unknown = this.reflector.getAllAndOverride(
      REQUIRED_PERMISSION_KEY, [context.getHandler(), context.getClass()],
    );
    // Only genuinely absent metadata is a no-op. A present but invalid value
    // ('' / null / unknown name / non-string) fails closed.
    if (required === undefined) return true;
    if (!isPermission(required)) throw denied(required);

    const { user } = context.switchToHttp().getRequest();
    if (!user) throw denied(required);
    if (ADMIN_PROHIBITED.includes(required) && this.permissions.isAdministrative(user)) throw denied(required);
    if (!this.permissions.has(user, required)) throw denied(required);
    return true;
  }
}

function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

function denied(permission: unknown) {
  return new AppError(HttpStatus.FORBIDDEN, 'PERMISSION_REQUIRED', 'You do not have permission to do this.', { permission });
}
