/**
 * Database-level guarantee for "view as" (src/auth/view-as): while the current request is made with a viewing token
 * (src/common/request-context.ts), every statement that would change data is refused before it reaches PostgreSQL,
 * with 403 VIEW_AS_READ_ONLY. The read-only guard already refuses every non-GET request; this catches any write a
 * GET handler might make (now or added later), including fire-and-forget ones.
 *
 * It wraps the driver adapter, so every query path (model calls, interactive transactions, $queryRaw,
 * $executeRaw) goes through it. Requests that are not viewing ones are untouched.
 */
import { HttpStatus } from '@nestjs/common';
import type { PrismaPg } from '@prisma/adapter-pg';

import { AppError } from '../common/errors/app-error.js';
import { writesBlocked } from '../common/request-context.js';

type Adapter = Awaited<ReturnType<PrismaPg['connect']>>;
type Tx = Awaited<ReturnType<Adapter['startTransaction']>>;
type Query = Parameters<Adapter['queryRaw']>[0];

/** Leading SQL comments and whitespace. */
const LEAD = String.raw`^(?:\s+|--[^\n]*\n|/\*[\s\S]*?\*/)*`;
const WRITE_START = new RegExp(`${LEAD}(?:insert|update|delete|merge|upsert|truncate|create|alter|drop|grant|revoke|copy|comment|vacuum|reindex|cluster|refresh|call|do|lock|import|security|reassign)\\b`, 'i');
/** A data-modifying statement inside a WITH query (PostgreSQL allows INSERT / UPDATE / DELETE in a CTE). */
const WITH_START = new RegExp(`${LEAD}with\\b`, 'i');
const MODIFYING_CTE = /\b(?:insert\s+into|delete\s+from|update\s+(?:only\s+)?["\w.]+\s+set)\b/i;

/** True for a statement that changes data or schema. SELECT ... FOR UPDATE (a row lock) is a read. */
export function isWriteStatement(sql: string): boolean {
  if (WRITE_START.test(sql)) return true;
  return WITH_START.test(sql) && MODIFYING_CTE.test(sql);
}

export function viewAsReadOnlyError(): AppError {
  return new AppError(HttpStatus.FORBIDDEN, 'VIEW_AS_READ_ONLY',
    'You are viewing the platform as another user. Nothing can be changed in this view. Return to your own account to make changes.');
}

function check(query: Query | string): void {
  const sql = typeof query === 'string' ? query : query.sql;
  if (writesBlocked() && isWriteStatement(sql)) throw viewAsReadOnlyError();
}

function guardQueryable<T extends Adapter | Tx>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'queryRaw' || prop === 'executeRaw') {
        return async (query: Query) => { check(query); return (value as (q: Query) => unknown).call(obj, query); };
      }
      if (prop === 'executeScript') {
        return async (script: string) => { check(script); return (value as (s: string) => unknown).call(obj, script); };
      }
      if (prop === 'startTransaction') {
        return async (...args: unknown[]) => guardQueryable(await (value as (...a: unknown[]) => Promise<Tx>).apply(obj, args));
      }
      return (value as (...a: unknown[]) => unknown).bind(obj);
    },
  });
}

/** The adapter factory, wrapped so that every connection it opens refuses writes during a viewing request. */
export function readOnlyWhileViewing(factory: PrismaPg): PrismaPg {
  return new Proxy(factory, {
    get(obj, prop, receiver) {
      const value: unknown = Reflect.get(obj, prop, receiver);
      if (prop === 'connect' && typeof value === 'function') {
        return async () => guardQueryable(await (value as () => Promise<Adapter>).call(obj));
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(obj) : value;
    },
  });
}
