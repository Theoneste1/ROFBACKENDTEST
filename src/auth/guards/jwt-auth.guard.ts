import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator.js';
import { AppError } from '../../common/errors/app-error.js';
import { bearerClaimsViewAs, viewAsEnded } from '../view-as/view-as.errors.js';

/**
 * Registered globally: every route requires a valid access token unless it is
 * marked with @Public().
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context);
  }

  /** A viewing ("view as") token that no longer works — expired included — answers 401 VIEW_AS_ENDED. */
  handleRequest<TUser = unknown>(err: unknown, user: unknown, info: unknown, context: ExecutionContext, status?: unknown): TUser {
    if ((err || !user) && !(err instanceof AppError) && bearerClaimsViewAs(context.switchToHttp().getRequest())) {
      throw viewAsEnded();
    }
    return super.handleRequest(err, user, info, context, status);
  }
}
