import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import { BEFORE_DATE_OF_BIRTH_KEY } from '../../common/decorators/date-of-birth-step.decorator.js';
import { AppError } from '../../common/errors/app-error.js';
import type { AuthUser } from '../../common/auth-user.js';

/**
 * First-sign-in date of birth (owner decision 9.3, 2026-11-18). A student created by an Administrator, invited or
 * imported may have no date of birth; self-registration requires one. Until the student gives it
 * (PUT /api/v1/me/date-of-birth), every route except the few marked @AllowedBeforeDateOfBirth answers
 * 403 DATE_OF_BIRTH_REQUIRED. Read fresh on each request (JwtStrategy), so the step ends as soon as it is given.
 * Other roles, and students who have a date of birth, are never affected. Registered globally after JwtAuthGuard.
 */
@Injectable()
export class DateOfBirthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    const user = context.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user?.dateOfBirthRequired) return true;
    if (this.reflector.getAllAndOverride<boolean>(BEFORE_DATE_OF_BIRTH_KEY, targets)) return true;
    throw new AppError(HttpStatus.FORBIDDEN, 'DATE_OF_BIRTH_REQUIRED',
      'Add your date of birth to continue.', { action: 'PUT /api/v1/me/date-of-birth' });
  }
}
