/**
 * One append-only AuditLog row for every state-changing request made by an
 * ADMIN or SUPER_ADMIN (plan §8.2 "Audit", P1-08), in addition to the domain
 * audit entries the services write with previous/new values.
 *
 * Recorded: HTTP method, route template, path parameters (record IDs), outcome
 * status and request ID. Never request or response bodies, nor query strings
 * (they can carry personal data such as search terms). Failed requests are
 * recorded too. Writing the row can never change the response: AuditService
 * logs and swallows its own errors.
 */
import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import type { Request } from 'express';
import { Observable, catchError, from, mergeMap, throwError } from 'rxjs';

import { isAdmin } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';
import { AuditService } from './audit.service.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class AdminRequestAuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: AuthUser; id?: string }>();
    const user = req.user;
    if (!user || !isAdmin(user) || !STATE_CHANGING.has(req.method)) return next.handle();

    const record = (status: number) =>
      this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'ADMIN_REQUEST', entity: 'Request',
        metadata: {
          method:    req.method,
          route:     (req.route as { path?: string } | undefined)?.path ?? null,
          params:    { ...req.params },
          outcome:   status,
          requestId: req.id ?? null,
        },
      });
    // The response waits for the row (deterministic); AuditService never throws without a transaction.
    return next.handle().pipe(
      mergeMap(async (value) => {
        // The status Nest will send: the handler's @HttpCode, else 201 for POST, 200 otherwise.
        const code: number | undefined = Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler());
        await record(code ?? (req.method === 'POST' ? 201 : 200));
        return value;
      }),
      catchError((err: unknown) =>
        from(record(err instanceof HttpException ? err.getStatus() : 500)).pipe(mergeMap(() => throwError(() => err)))),
    );
  }
}
