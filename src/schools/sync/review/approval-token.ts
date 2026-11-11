/**
 * The apply token a Super Admin's approval issues (S2b). Signed (HMAC-SHA256, a key derived from
 * JWT_SECRET for this purpose only) and bound to the run, its file, both digests, the review
 * generation and the approver; `jti` must equal the run's approvalTokenId, so a new approval, a
 * decision or a recompare invalidates every earlier token. Tokens are never stored: the run keeps
 * the id, the audit log the SHA-256 of the token.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface ApprovalClaims {
  v: 1;
  run: string;
  file: string;
  report: string;
  decisions: string;
  gen: number;
  jti: string;
  sub: string;
  exp: number;
}

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

export function approvalKey(jwtSecret: string): Buffer {
  return createHmac('sha256', jwtSecret).update('school-sync-apply-approval-v1').digest();
}

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function signApproval(key: Buffer, claims: ApprovalClaims): string {
  const body = b64(JSON.stringify(claims));
  return `${body}.${b64(createHmac('sha256', key).update(body).digest())}`;
}

export function tokenSha256(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ApprovalCheck = { ok: true; claims: ApprovalClaims } | { ok: false; reason: 'MALFORMED' | 'SIGNATURE' | 'EXPIRED' | 'WRONG_RUN' | 'WRONG_USER' };

export function checkApproval(key: Buffer, token: string, expect: { run: string; sub: string; now: number }): ApprovalCheck {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return { ok: false, reason: 'MALFORMED' };
  const want = createHmac('sha256', key).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'SIGNATURE' };
  let claims: ApprovalClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ApprovalClaims;
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (claims.v !== 1 || typeof claims.exp !== 'number') return { ok: false, reason: 'MALFORMED' };
  if (claims.run !== expect.run) return { ok: false, reason: 'WRONG_RUN' };
  if (claims.sub !== expect.sub) return { ok: false, reason: 'WRONG_USER' };
  if (claims.exp <= expect.now) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, claims };
}
