/**
 * Per-request context (AsyncLocalStorage), opened by RequestContextMiddleware before anything else runs.
 *
 * It carries one fact today: whether the request is made with a "view as" token (an administrator viewing the
 * platform as another user, READ ONLY — src/auth/view-as). While it is set:
 *   - the database refuses every write (src/prisma/read-only-while-viewing.ts), except inside
 *     allowWritesWhileViewing() — used only to end the viewing session and to write audit rows (as the viewer);
 *   - side effects of reading (activity log, "viewed" counters, a course's first-open state) are skipped, so the
 *     viewer's requests never count as the viewed user's activity.
 * The read-only guard (ViewAsReadOnlyGuard) refuses every non-GET request first; this is the second line.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export interface ViewingContext {
  sessionId: string;
  actorId:   string;
  actorRole: string;
  targetId:  string;
}

interface RequestStore {
  viewAs?:        ViewingContext;
  writesAllowed?: boolean;
}

const storage = new AsyncLocalStorage<RequestStore>();

/** Run `fn` (and everything it starts) with a fresh, empty request context. */
export function runWithRequestContext<T>(fn: () => T): T {
  return storage.run({}, fn);
}

/** Mark the current request as made with a viewing token (JwtStrategy). No-op outside a request context. */
export function markViewing(viewAs: ViewingContext): void {
  const store = storage.getStore();
  if (store) store.viewAs = viewAs;
}

/** The viewing session of the current request, if it is made with a viewing token. */
export function viewingContext(): ViewingContext | undefined {
  return storage.getStore()?.viewAs;
}

export const isViewing = (): boolean => viewingContext() !== undefined;

/** True when the database must refuse writes: a viewing request outside allowWritesWhileViewing(). */
export function writesBlocked(): boolean {
  const store = storage.getStore();
  return store?.viewAs !== undefined && store.writesAllowed !== true;
}

/**
 * Run `fn` with database writes allowed although the request is a viewing one. Only for the viewing session's own
 * bookkeeping (ending it) and audit rows written as the viewer — never for the viewed user's data.
 */
export function allowWritesWhileViewing<T>(fn: () => T): T {
  const store = storage.getStore();
  if (!store?.viewAs) return fn();
  return storage.run({ ...store, writesAllowed: true }, fn);
}

/** Opens the request context; registered first, for every route (app.module.ts). */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    runWithRequestContext(next);
  }
}
