import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkReviewToken, REVIEW_TOKEN_TTL_MS, reviewKey, signReviewToken, snapshotDigest, type ReviewRow } from './review-token.js';

const KEY = reviewKey('x'.repeat(40));
const NOW = new Date('2026-11-11T10:00:00Z');
const ROWS: ReviewRow[] = [
  { row: 5, candidates: [{ id: 'b', name: 'Lycée de Huye', code: null, district: 'Huye', isActive: true }, { id: 'a', name: 'LYCEE DE HUYE', code: '220001', district: 'Huye', isActive: false }] },
  { row: 2, candidates: [{ id: 'c', name: 'GS X', code: null, district: null, isActive: true }] },
];

describe('review token (PR D)', () => {
  it('round-trips for the same Administrator and file; expires after 15 minutes', () => {
    const { token, expiresAt } = signReviewToken(KEY, { sub: 'admin-1', file: 'f'.repeat(64), snap: snapshotDigest(ROWS) }, NOW);
    expect(expiresAt.getTime() - NOW.getTime()).toBe(REVIEW_TOKEN_TTL_MS);
    const check = checkReviewToken(KEY, token, { sub: 'admin-1', file: 'f'.repeat(64) });
    expect(check).toMatchObject({ ok: true, payload: { v: 1, sub: 'admin-1', snap: snapshotDigest(ROWS), exp: expiresAt.getTime() } });
  });

  it('refuses another Administrator, another file, a tampered payload or signature, another key, garbage', () => {
    const { token } = signReviewToken(KEY, { sub: 'admin-1', file: 'f1', snap: 's' }, NOW);
    expect(checkReviewToken(KEY, token, { sub: 'admin-2', file: 'f1' })).toEqual({ ok: false, reason: 'WRONG_USER' });
    expect(checkReviewToken(KEY, token, { sub: 'admin-1', file: 'f2' })).toEqual({ ok: false, reason: 'WRONG_FILE' });
    const [body, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), sub: 'admin-2' })).toString('base64url');
    expect(checkReviewToken(KEY, `${forged}.${sig}`, { sub: 'admin-2', file: 'f1' })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(checkReviewToken(KEY, `${body}.${sig.slice(0, -2)}AA`, { sub: 'admin-1', file: 'f1' })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    expect(checkReviewToken(reviewKey('y'.repeat(40)), token, { sub: 'admin-1', file: 'f1' })).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
    for (const junk of ['', 'abc', 'a.b.c', '.x', 'x.']) expect(checkReviewToken(KEY, junk, { sub: 'admin-1', file: 'f1' }).ok).toBe(false);
  });

  it('the signature is compared in constant time (timingSafeEqual on equal-length buffers), never with === on strings', () => {
    const source = readFileSync(join(__dirname, 'review-token.ts'), 'utf8');
    expect(source).toMatch(/given\.length !== expected\.length \|\| !timingSafeEqual\(given, expected\)/);
    expect(source).not.toMatch(/parts\[1\]\s*===|===\s*parts\[1\]/);
  });

  it('the snapshot is canonical (row and candidate order do not matter) and changes with ANY candidate field or flagged row', () => {
    const base = snapshotDigest(ROWS);
    expect(snapshotDigest([...ROWS].reverse().map((r) => ({ ...r, candidates: [...r.candidates].reverse() })))).toBe(base);
    const variant = (fn: (rows: ReviewRow[]) => void) => { const copy = structuredClone(ROWS); fn(copy); return snapshotDigest(copy); };
    for (const change of [
      (r: ReviewRow[]) => { r[0].candidates[0].id = 'z'; },
      (r: ReviewRow[]) => { r[0].candidates[0].name = 'Lycée de Huye II'; },
      (r: ReviewRow[]) => { r[0].candidates[1].code = '220002'; },
      (r: ReviewRow[]) => { r[0].candidates[0].district = 'Gisagara'; },
      (r: ReviewRow[]) => { r[0].candidates[1].isActive = true; },
      (r: ReviewRow[]) => { r[1].row = 3; },
      (r: ReviewRow[]) => { r.pop(); },
      (r: ReviewRow[]) => { r[1].candidates.push({ id: 'd', name: 'GS X', code: null, district: null, isActive: true }); },
    ]) expect(variant(change)).not.toBe(base);
  });
});
