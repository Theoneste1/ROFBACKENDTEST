import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthUser } from '../../common/auth-user.js';
import { BEFORE_BANKING_KEY } from '../../common/decorators/banking-step.decorator.js';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import { AppError } from '../../common/errors/app-error.js';

/**
 * Banking information first (owner 2026-11-25). A Teacher, Coach or Head Coach whose banking information is not
 * complete (src/banking/banking-rules.ts, read with the user on every request by JwtStrategy) gets 403
 * BANKING_DETAILS_REQUIRED on every route except the few marked @AllowedBeforeBankingDetails, whatever page or tab the
 * request comes from. Saving complete details ends it on the next request. Other roles are never affected; a "view
 * as" session is not (it is read only). Registered globally after DateOfBirthGuard.
 */
@Injectable()
export class BankingDetailsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user?.bankingRequired) return true;
    if (this.reflector.getAllAndOverride<boolean>(BEFORE_BANKING_KEY, targets)) return true;
    throw new AppError(HttpStatus.FORBIDDEN, 'BANKING_DETAILS_REQUIRED',
      'Complete your banking information to continue.', { action: 'PUT /api/v1/me/banking' });
  }
}
