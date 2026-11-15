/**
 * Test helper (excluded from the build): which of the pre-Phase-1 roles may call
 * a handler — from @Roles, or, for a handler converted to @RequirePermission
 * (P1-06), the roles holding that permission in the approved catalogue (plan
 * §5), never an administrator for grading or assignment authoring (RS1).
 *
 * Lets controller specs keep asserting "submit is STUDENT only" whichever
 * declaration the route uses. Resolved like the guards: method, then class.
 */
import { Reflector } from '@nestjs/core';

import { ROLES_KEY } from './decorators/roles.decorator.js';
import { REQUIRED_PERMISSION_KEY } from './decorators/require-permission.decorator.js';
import { ADMIN_PROHIBITED, ROLE_GRANTS, type LegacyRole, type Permission } from './permissions.js';

const reflector = new Reflector();
const LEGACY: readonly LegacyRole[] = ['STUDENT', 'MENTOR', 'ADMIN'];

export function legacyRolesFor(cls: Function, method: string): string[] | undefined {
  const handler = (cls.prototype as Record<string, Function>)[method];
  const permission = reflector.getAllAndOverride<Permission | undefined>(REQUIRED_PERMISSION_KEY, [handler, cls]);
  if (permission !== undefined) {
    return LEGACY.filter((r) => permission in ROLE_GRANTS[r] && !(r === 'ADMIN' && ADMIN_PROHIBITED.includes(permission)));
  }
  return reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [handler, cls]);
}

export function requiredPermission(cls: Function, method: string): string | undefined {
  const handler = (cls.prototype as Record<string, Function>)[method];
  return reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION_KEY, [handler, cls]);
}
