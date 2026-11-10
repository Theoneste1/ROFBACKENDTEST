/**
 * One append-only AuditLog row for every state-changing request made by an
 * ADMIN or SUPER_ADMIN (plan §8.2 "Audit", P1-08) — whatever its outcome,
 * including requests refused by the guards (which run before any interceptor,
 * so an interceptor could not see them).
 *
 * Registered as middleware, it only attaches a listener to the response's
 * 'finish' event, which fires exactly once per response. At that point the
 * authenticated user (set by JwtAuthGuard on the same request) and the matched
 * route are known, and res.statusCode is the status actually sent — success,
 * 403 guard refusal, 400 validation, 404/409 service errors alike.
 *
 * Recorded: HTTP method, route TEMPLATE (never the raw URL or query string),
 * identifier path parameters, final status, request ID. Never bodies, query
 * strings, headers, passwords or tokens; a path parameter whose name is not an
 * known identifier is stored as "[omitted]". Unauthenticated (401) or
 * throttled (429) requests have no identified administrator and are not
 * recorded here. Writing the row happens after the response is sent and can
 * never alter it: errors are logged and swallowed.
 */
import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import { isAdmin } from '../common/access/roles.js';
import type { AuthUser } from '../common/auth-user.js';
import { AuditService } from './audit.service.js';

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Path parameters that are record identifiers (or fixed enums) and safe to record. */
export const RECORDED_PARAMS: ReadonlySet<string> = new Set([
  'id', 'courseId', 'resourceId', 'attachmentId', 'userId', 'submissionId', 'assignmentId', 'revisionNumber', 'op',
]);

type AuditedRequest = Request & { user?: AuthUser; id?: string };

@Injectable()
export class AdminRequestAuditMiddleware implements NestMiddleware {
  private readonly logger = new Logger(AdminRequestAuditMiddleware.name);

  constructor(private readonly audit: AuditService) {}

  use(req: AuditedRequest, res: Response, next: NextFunction): void {
    if (STATE_CHANGING.has(req.method)) res.once('finish', () => void this.record(req, res));
    next();
  }

  private async record(req: AuditedRequest, res: Response): Promise<void> {
    try {
      const user = req.user;
      if (!user || !isAdmin(user)) return;
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.params ?? {})) params[k] = RECORDED_PARAMS.has(k) ? String(v) : '[omitted]';
      await this.audit.log({
        actorId: user.id, actorRole: user.role,
        action: 'ADMIN_REQUEST', entity: 'Request',
        metadata: {
          method:    req.method,
          route:     (req.route as { path?: string } | undefined)?.path ?? null,
          params,
          outcome:   res.statusCode,
          requestId: req.id ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`Could not record the administrator request audit row: ${(err as Error).message}`);
    }
  }
}
