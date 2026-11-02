import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';

/**
 * Role-based access control guard.
 *
 * Rules:
 *  - If no @Roles() decorator is present, the route is open to all authenticated users.
 *  - ADMIN always passes, regardless of which roles the route requires.
 *    This means an Admin can do everything a Student or Mentor can do without
 *    needing to add 'ADMIN' to every @Roles() decorator.
 *  - Other roles must be explicitly listed in @Roles().
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() on this route — any authenticated user may proceed.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      return false;
    }

    // ADMIN is a super-role: it passes every role check unconditionally.
    if (user.role === 'ADMIN') {
      return true;
    }

    return requiredRoles.includes(user.role);
  }
}
