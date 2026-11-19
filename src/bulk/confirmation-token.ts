/**
 * The bulk confirmation token (v2; owner requirement 2026-11-19: "a secure, short-lived confirmation token tied to the
 * exact validated selection and requested action").
 *
 *   token = "v2." <actorId> "." <count> "." <expiresAt, unix seconds> "." <binding digest> "." <signature>
 *   binding digest = base64url(SHA-256( canonical JSON { v: 2, actorId, entityType, action, params, selection }
 *                                       "\n" every matching record id, sorted, each followed by "," ))
 *   signature      = base64url(HMAC-SHA256(key, everything before the last ".")), compared in constant time
 *   key            = HMAC-SHA256(JWT_SECRET, "rof:bulk-confirmation:v2")  (domain separation: no new secret)
 *
 * The token is opaque to clients (at most 200 characters, like v1). It is checked at execution in this order:
 *   MALFORMED / BAD_SIGNATURE (also every v1 token) → WRONG_ACTOR → EXPIRED (15 minutes) → the binding digest,
 * recomputed from the request and from the records the selection matches under the membership lock → any
 * difference (another action, other parameters, another selection, another record set) means CHANGED.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CONFIRMATION_TTL_MS = 15 * 60_000;
const KEY_LABEL = 'rof:bulk-confirmation:v2';

export interface ConfirmationBinding {
  actorId: string;
  entityType: string;
  action: string;
  params: Record<string, unknown>;
  selection: unknown;
  /** Every record the selection matches (any order; sorted here). */
  ids: readonly string[];
}

export type ConfirmationRefusal = 'MALFORMED' | 'BAD_SIGNATURE' | 'WRONG_ACTOR' | 'EXPIRED' | 'CHANGED';

export function confirmationKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_LABEL).digest();
}

/** A JSON value with object keys sorted and undefined / null / '' members dropped (arrays keep their order). */
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

export function bindingDigest(b: ConfirmationBinding): string {
  const h = createHash('sha256');
  h.update(JSON.stringify(canonical({ v: 2, actorId: b.actorId, entityType: b.entityType, action: b.action, params: b.params, selection: b.selection })));
  h.update('\n');
  for (const id of [...b.ids].sort()) h.update(id + ',');
  return h.digest('base64url');
}

const sign = (key: Buffer, body: string) => createHmac('sha256', key).update(body).digest();

export function signConfirmation(key: Buffer, b: ConfirmationBinding, now: Date = new Date()): { token: string; expiresAt: Date } {
  const exp = Math.floor((now.getTime() + CONFIRMATION_TTL_MS) / 1000);
  const body = `v2.${b.actorId}.${b.ids.length}.${exp}.${bindingDigest(b)}`;
  return { token: `${body}.${sign(key, body).toString('base64url')}`, expiresAt: new Date(exp * 1000) };
}

export interface ConfirmationClaims { actorId: string; count: number; expiresAt: Date; digest: string }

/** Signature and shape only (no actor, expiry or binding check). */
export function readConfirmation(key: Buffer, token: string): { ok: true; claims: ConfirmationClaims } | { ok: false; reason: 'MALFORMED' | 'BAD_SIGNATURE' } {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 6 || parts[0] !== 'v2' || parts.some((p) => !p)) return { ok: false, reason: 'MALFORMED' };
  const [, actorId, count, exp, digest, sig] = parts;
  if (!/^\d{1,9}$/.test(count) || !/^\d{1,12}$/.test(exp) || !/^[A-Za-z0-9_-]{43}$/.test(digest) || !/^[A-Za-z0-9_-]{43}$/.test(sig)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  // Compare the canonical TEXT of the signature, not its decoded bytes: 32 bytes take 43 base64url characters whose last
  // one carries 2 unused bits, so decoding would accept 4 spellings of one signature — and the token, whose single use
  // is enforced on its text, could then be replayed by changing its last character.
  const expected = Buffer.from(sign(key, parts.slice(0, 5).join('.')).toString('base64url'));
  const given = Buffer.from(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'BAD_SIGNATURE' };
  return { ok: true, claims: { actorId, count: Number(count), expiresAt: new Date(Number(exp) * 1000), digest } };
}

/**
 * Everything that can be checked before the records are read: signature, administrator, expiry. Returns the claims, or
 * why the token is refused.
 */
export function checkConfirmation(key: Buffer, token: string, actorId: string, now: Date = new Date()):
  { ok: true; claims: ConfirmationClaims } | { ok: false; reason: ConfirmationRefusal } {
  const r = readConfirmation(key, token);
  if (!r.ok) return r;
  if (r.claims.actorId !== actorId) return { ok: false, reason: 'WRONG_ACTOR' };
  if (r.claims.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'EXPIRED' };
  return r;
}

/** The binding check (under the membership lock): the digest of what is being executed now must equal the token's. */
export function bindingMatches(claims: ConfirmationClaims, b: ConfirmationBinding): boolean {
  const d = Buffer.from(bindingDigest(b));
  const c = Buffer.from(claims.digest);
  return claims.actorId === b.actorId && claims.count === b.ids.length && d.length === c.length && timingSafeEqual(d, c);
}
