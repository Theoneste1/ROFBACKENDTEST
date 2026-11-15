/**
 * Review token for possible duplicates in a school import (PR D; owner-approved 2026-11-11).
 *
 * It binds an Administrator's confirmation to exactly what they reviewed:
 *
 *   payload = { v: 1, sub: <Administrator id>, file: <SHA-256 of the uploaded bytes>,
 *               snap: <SHA-256 of the canonical candidate snapshot>, iat, exp }
 *   token   = base64url(JSON payload) "." base64url(HMAC-SHA256(key, base64url payload))
 *
 * The canonical snapshot lists the flagged rows in row order, each with its candidates sorted by
 * id, each candidate exactly { id, name, code, district, isActive } — so ANY change to a
 * candidate, or to which rows are flagged, changes `snap`.
 *
 * The key is derived from JWT_SECRET with a distinct label (domain separation): no new secret or
 * environment variable. Tokens live REVIEW_TOKEN_TTL_MS. The signature is compared in constant time.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const REVIEW_TOKEN_TTL_MS = 15 * 60 * 1000;
const KEY_LABEL = 'rof:school-import-review:v1';

export interface ReviewCandidate { id: string; name: string; code: string | null; district: string | null; isActive: boolean }
export interface ReviewRow { row: number; candidates: ReviewCandidate[] }
interface Payload { v: 1; sub: string; file: string; snap: string; iat: number; exp: number }

export type TokenCheck =
  | { ok: true; payload: Payload }
  | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' | 'WRONG_USER' | 'WRONG_FILE' };

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function reviewKey(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update(KEY_LABEL).digest();
}

/** SHA-256 of the canonical snapshot (fixed key order; rows by row number; candidates by id). */
export function snapshotDigest(rows: readonly ReviewRow[]): string {
  const canonical = [...rows]
    .sort((a, b) => a.row - b.row)
    .map((r) => ({
      row: r.row,
      candidates: [...r.candidates]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((c) => ({ id: c.id, name: c.name, code: c.code ?? null, district: c.district ?? null, isActive: c.isActive })),
    }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function signReviewToken(key: Buffer, claims: { sub: string; file: string; snap: string }, now: Date): { token: string; expiresAt: Date } {
  const iat = now.getTime();
  const payload: Payload = { v: 1, sub: claims.sub, file: claims.file, snap: claims.snap, iat, exp: iat + REVIEW_TOKEN_TTL_MS };
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', key).update(body).digest());
  return { token: `${body}.${sig}`, expiresAt: new Date(payload.exp) };
}

/** Signature, version, Administrator and file. Expiry and snapshot are checked by the caller under its locks. */
export function checkReviewToken(key: Buffer, token: string, expect: { sub: string; file: string }): TokenCheck {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'MALFORMED' };
  const expected = createHmac('sha256', key).update(parts[0]).digest();
  let given: Buffer;
  try { given = Buffer.from(parts[1], 'base64url'); } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };
  let payload: Payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Payload; } catch { return { ok: false, reason: 'MALFORMED' }; }
  if (payload?.v !== 1 || typeof payload.exp !== 'number' || typeof payload.snap !== 'string') return { ok: false, reason: 'MALFORMED' };
  if (payload.sub !== expect.sub) return { ok: false, reason: 'WRONG_USER' };
  if (payload.file !== expect.file) return { ok: false, reason: 'WRONG_FILE' };
  return { ok: true, payload };
}
