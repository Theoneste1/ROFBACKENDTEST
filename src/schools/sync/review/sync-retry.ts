/**
 * Whole-transaction retry for the directory sync (S2b; owner-approved 2026-11-11).
 *
 * A REPEATABLE READ transaction whose `SELECT … FOR UPDATE` waits for a concurrent transaction
 * that changes the row and commits raises 40001 ("could not serialize access due to concurrent
 * update"), reported by Prisma as P2034 (which also covers a detected deadlock). The ONLY errors
 * retried are those: each attempt is a fresh transaction (a new snapshot), every write of a failed
 * attempt — directory writes and audit entries alike — is rolled back with it, and every check
 * (run status, expiry, decisions) runs again. At most `attempts` (3) attempts; then `exhausted()`.
 */
import { Prisma } from '../../../generated/prisma/client.js';

export const SYNC_TX_ATTEMPTS = 3;

/** True for a serialization failure (40001) or Prisma's P2034 — and nothing else. */
export function isSerializationFailure(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') return true;
  const seen = new Set<unknown>();
  for (let e: unknown = err; e && typeof e === 'object' && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    if (code === '40001' || code === 'P2034') return true;
    const meta = (e as { meta?: { code?: unknown } }).meta;
    if (meta?.code === '40001') return true;
  }
  return false;
}

export async function withSerializationRetry<T>(
  attempt: (n: number) => Promise<T>,
  exhausted: (last: unknown) => Error,
  opts: { attempts?: number; backoffMs?: (n: number) => number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? SYNC_TX_ATTEMPTS;
  const backoff = opts.backoffMs ?? ((n: number) => 20 * n + Math.floor(Math.random() * 30));
  let last: unknown;
  for (let n = 1; n <= attempts; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      if (!isSerializationFailure(err)) throw err;
      last = err;
      if (n < attempts) await new Promise((r) => setTimeout(r, backoff(n)));
    }
  }
  throw exhausted(last);
}
