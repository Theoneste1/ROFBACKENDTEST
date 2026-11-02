import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';

/**
 * Role-based access control guard (registered globally, after JwtAuthGuard).
 *
 * Rules:
 *  - No @Roles() on the route or controller → any authenticated user.
 *  - Otherwise the user's role must be listed EXPLICITLY.
 *
 * There is deliberately no ADMIN override: administrators coordinate the
 * academic workflow but must not grade or give formal feedback, so routes such
 * as "mark submission" are MENTOR-only and an ADMIN is refused there.
 * Routes admins may use list 'ADMIN' explicitly.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, targets);
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    return !!user && requiredRoles.includes(user.role);
  }
}
