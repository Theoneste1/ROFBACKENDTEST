/**
 * The response backstop of Super Administrator privacy (src/common/access/super-admin-privacy.ts).
 *
 * For every caller who is not a Super Administrator (including an anonymous caller), each JSON response body is walked;
 * any plain object that looks like a user (an `id` and one of username / firstName / lastName / email) whose id belongs to
 * a Super Administrator is replaced by the neutral "ROF Administration" identity (the id is kept: looking it up answers
 * 404). The Super Administrator ids are read fresh for each such response (one query on the role index; none when the
 * body holds no user-shaped object) — no cache, so a role change is effective at once.
 *
 * Streamed responses (@Res() handlers, files, CSV exports) never pass through here; those that can contain users apply
 * the rule in their own queries.
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { from, mergeMap, type Observable } from 'rxjs';

import { PrismaService } from '../../prisma/prisma.service.js';
import { containsUserShape, maskSuperAdmins, seesSuperAdmins } from './super-admin-privacy.js';

/** The anonymous routes under /auth/ (they answer with the signing-in account itself). */
export function isSignInRoute(url: string): boolean {
  const path = url.split('?')[0];
  return /^\/api\/v\d+\/auth\//.test(path);
}

@Injectable()
export class SuperAdminPrivacyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<{ user?: { role: string }; originalUrl?: string; url?: string }>();
    // Signing in (login, token refresh, activation, view-as exchange) answers with the account that signs in, before any
    // caller is known: that is the account's own data, never masked.
    if (!req.user && isSignInRoute(req.originalUrl ?? req.url ?? '')) return next.handle();
    return next.handle().pipe(mergeMap((body: unknown) => from(this.mask(req.user, body))));
  }

  /** The body as this viewer may see it. */
  async mask(viewer: { role: string } | undefined, body: unknown): Promise<unknown> {
    if (seesSuperAdmins(viewer) || body === null || typeof body !== 'object') return body;
    if (!containsUserShape(body)) return body;
    // Super Administrators are a handful of accounts (index on role): read them all.
    const all = await this.prisma.user.findMany({ where: { role: 'SUPER_ADMIN' }, select: { id: true } });
    return maskSuperAdmins(body, new Set(all.map((u) => u.id)));
  }
}
