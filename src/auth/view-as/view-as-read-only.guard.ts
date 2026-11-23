import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthUser } from '../../common/auth-user.js';
import { ALLOWED_WHILE_VIEWING_KEY } from './allowed-while-viewing.decorator.js';
import { bearerClaimsViewAs, viewAsReadOnly } from './view-as.errors.js';

/** Methods that read only. Everything else changes something. */
export const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * "View as" is READ ONLY (owner decision 2026-11-23). Registered globally right after JwtAuthGuard, so no route can
 * forget it: every request with another method, made with a viewing token, is refused with 403 VIEW_AS_READ_ONLY —
 * on public routes too (a token that merely claims to be a viewing one is refused as well; e.g. /auth/refresh can
 * never turn a viewing tab into a normal session). Only routes marked @AllowedWhileViewing pass.
 */
@Injectable()
export class ViewAsReadOnlyGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ method: string; user?: AuthUser; headers?: Record<string, unknown> }>();
    if (READ_METHODS.has(String(req.method).toUpperCase())) return true;
    if (this.reflector.getAllAndOverride<boolean>(ALLOWED_WHILE_VIEWING_KEY, [context.getHandler(), context.getClass()])) return true;
    if (req.user?.viewAs) throw viewAsReadOnly(req.user.viewAs.target.name);
    if (bearerClaimsViewAs(req)) throw viewAsReadOnly(null);
    return true;
  }
}
