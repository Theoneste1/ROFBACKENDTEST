/**
 * One-time upload of an OPTIONAL profile picture right after registration (REG-02, 2026-11-18). The new account
 * (student) or application (Teacher / Coach) cannot sign in yet, so the registration answer carries a short-lived,
 * signed token that allows exactly one thing: setting the FIRST picture of that account or application. HMAC-SHA256
 * with the server's JWT secret and a dedicated purpose label (it is never accepted as a sign-in token), 30 minutes.
 * Pure; unit-tested.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type RegistrationAvatarKind = 'STUDENT' | 'TEACHER' | 'TEACHER_APPLICATION' | 'COACH_APPLICATION';
export const REGISTRATION_AVATAR_TTL_MS = 30 * 60 * 1000;
const PURPOSE = 'rof:registration-avatar:v1';
const KINDS: readonly RegistrationAvatarKind[] = ['STUDENT', 'TEACHER', 'TEACHER_APPLICATION', 'COACH_APPLICATION'];

const sign = (secret: string, body: string) => createHmac('sha256', `${PURPOSE}:${secret}`).update(body).digest('base64url');

export function issueRegistrationAvatarToken(secret: string, kind: RegistrationAvatarKind, id: string, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ k: kind, i: id, e: now + REGISTRATION_AVATAR_TTL_MS })).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** The kind and id the token was issued for, or null (malformed, wrong signature, expired). */
export function verifyRegistrationAvatarToken(secret: string, token: unknown, now = Date.now()): { kind: RegistrationAvatarKind; id: string } | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { k?: unknown; i?: unknown; e?: unknown };
    if (!KINDS.includes(p.k as RegistrationAvatarKind) || typeof p.i !== 'string' || typeof p.e !== 'number') return null;
    if (p.e <= now) return null;
    return { kind: p.k as RegistrationAvatarKind, id: p.i };
  } catch {
    return null;
  }
}
