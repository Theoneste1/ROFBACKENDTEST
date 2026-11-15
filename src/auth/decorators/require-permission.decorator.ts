import { SetMetadata } from '@nestjs/common';

import type { Permission } from '../permissions.js';

export const REQUIRED_PERMISSION_KEY = 'requiredPermission';

/**
 * The caller must hold this permission (PermissionGuard). Checks the permission
 * only; record-level and scope rules stay in the services.
 *
 * Method level only, one permission, never together with @Public, @Roles or
 * @Authenticated (route-declarations.spec.ts). No route uses it yet: routes
 * move from @Roles to @RequirePermission in P1-06, after equivalence tests.
 */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION_KEY, permission);
