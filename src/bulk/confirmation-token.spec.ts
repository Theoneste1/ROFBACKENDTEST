import { createHmac } from 'node:crypto';

import {
  bindingDigest, bindingMatches, canonical, checkConfirmation, confirmationKey, CONFIRMATION_TTL_MS, readConfirmation, signConfirmation,
  type ConfirmationBinding,
} from './confirmation-token.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = confirmationKey('x'.repeat(48));
const NOW = new Date('2026-11-19T10:00:00Z');
const base: ConfirmationBinding = {
  actorId: ADMIN, entityType: 'USER', action: 'suspend', params: {}, selection: { mode: 'filter', filter: { role: 'STUDENT' } }, ids: [A, B],
};

describe('bulk confirmation token (v2)', () => {
  const { token, expiresAt } = signConfirmation(key, base, NOW);

  it('is opaque, at most 200 characters, and expires 15 minutes after the preview', () => {
    expect(token).toMatch(/^v2\.[0-9a-f-]{36}\.2\.\d+\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
    expect(token.length).toBeLessThanOrEqual(200);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + CONFIRMATION_TTL_MS);
  });

  it('accepts the same administrator before expiry, and the binding of exactly what was previewed', () => {
    const r = checkConfirmation(key, token, ADMIN, new Date(NOW.getTime() + CONFIRMATION_TTL_MS - 1000));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(bindingMatches(r.claims, base)).toBe(true);
    expect(bindingMatches(r.claims, { ...base, ids: [B, A] })).toBe(true);   // order does not matter
  });

  it('is refused after expiry', () => {
    expect(checkConfirmation(key, token, ADMIN, new Date(NOW.getTime() + CONFIRMATION_TTL_MS))).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it('is refused for another administrator (even with a valid signature)', () => {
    expect(checkConfirmation(key, token, OTHER, NOW)).toEqual({ ok: false, reason: 'WRONG_ACTOR' });
    const r = readConfirmation(key, token);
    expect(r.ok && bindingMatches(r.claims, { ...base, actorId: OTHER })).toBe(false);
  });

  it('does not match another action, other parameters, another selection or another record set', () => {
    const r = readConfirmation(key, token);
    if (!r.ok) throw new Error('unreadable');
    expect(bindingMatches(r.claims, { ...base, action: 'archive' })).toBe(false);
    expect(bindingMatches(r.claims, { ...base, entityType: 'SCHOOL' })).toBe(false);
    expect(bindingMatches(r.claims, { ...base, params: { role: 'MENTOR' } })).toBe(false);
    expect(bindingMatches(r.claims, { ...base, selection: { mode: 'filter', filter: { role: 'MENTOR' } } })).toBe(false);
    expect(bindingMatches(r.claims, { ...base, selection: { mode: 'ids', ids: [A, B] } })).toBe(false);
    expect(bindingMatches(r.claims, { ...base, ids: [A, C] })).toBe(false);       // same count, other records
    expect(bindingMatches(r.claims, { ...base, ids: [A, B, C] })).toBe(false);
    expect(bindingMatches(r.claims, { ...base, ids: [A] })).toBe(false);
  });

  it('refuses any tampering: count, expiry, actor, digest or signature changed; another key; malformed and v1 tokens', () => {
    const parts = token.split('.');
    const swap = (i: number, v: string) => parts.map((p, j) => (j === i ? v : p)).join('.');
    expect(readConfirmation(key, swap(2, '3'))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(readConfirmation(key, swap(3, String(Number(parts[3]) + 3600)))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(readConfirmation(key, swap(1, OTHER))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(readConfirmation(key, swap(4, bindingDigest({ ...base, ids: [A, C] })))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(readConfirmation(key, swap(5, createHmac('sha256', 'guess').update('x').digest('base64url')))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(readConfirmation(confirmationKey('y'.repeat(48)), token)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    for (const bad of ['', 'v2', `v1.2.${'a'.repeat(64)}`, token + '.x', token.replace('v2.', 'v3.'), swap(2, '-1'), swap(5, 'short')]) {
      expect(readConfirmation(key, bad)).toEqual({ ok: false, reason: 'MALFORMED' });
    }
  });

  it('canonical JSON: key order and empty values do not matter; array order does', () => {
    expect(canonical({ b: 1, a: { d: '', c: [2, 1] }, e: null })).toEqual({ a: { c: [2, 1] }, b: 1 });
    expect(bindingDigest({ ...base, params: { b: 1, a: 2 } })).toBe(bindingDigest({ ...base, params: { a: 2, b: 1, c: undefined } }));
  });

  it('the key is derived from the secret with its own label (never the secret itself)', () => {
    expect(key.equals(Buffer.from('x'.repeat(48)))).toBe(false);
    expect(key.equals(createHmac('sha256', 'x'.repeat(48)).update('rof:school-import-review:v1').digest())).toBe(false);
  });
});
