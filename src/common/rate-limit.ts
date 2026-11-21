/**
 * Who a request is counted against (rate limiting), 2026-11-18 (owner approval: schools share one internet connection).
 *
 * Before: every limit counted per IP address. A school computer lab — many students behind one public IP — shared one
 * budget (120 API requests and 30 session refreshes a minute), so a class reached it within seconds.
 *
 * Now:
 *  - a request with a VALID access token (signature and expiry verified, HS256) counts against that user
 *    (`user:<id>`); a forged or expired token proves nothing and counts against the IP, as before — so a client
 *    cannot obtain fresh budgets by inventing tokens;
 *  - POST /auth/refresh counts its per-session limit against the refresh token presented (`rt:<sha256>`, never the
 *    token itself), or the IP when there is none;
 *  - a separate per-IP ceiling (throttler `ip`) still bounds everything one address can send, including refresh calls
 *    with made-up tokens (refresh tokens are 256-bit random values; a reused token revokes its whole family).
 * Credential routes (sign-in, activation, password reset…) have no valid access token: they stay per IP, unchanged.
 */
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';

/** The parts of a request the trackers read (Express request after cookie-parser and the body parser). */
export interface TrackedRequest {
  ip?: string;
  headers?: Record<string, unknown>;
  cookies?: Record<string, unknown>;
  body?: unknown;
}

export const REFRESH_COOKIE_NAME = 'rof_refresh';

const ipOf = (req: TrackedRequest) => `ip:${req.ip ?? 'unknown'}`;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The user of a valid access token, else the IP. */
export function userOrIpTracker(secret: string) {
  return (req: TrackedRequest): string => {
    const auth = req.headers?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.length < 4096) {
      try {
        const payload = jwt.verify(auth.slice(7), secret, { algorithms: ['HS256'] });
        if (payload && typeof payload === 'object' && typeof payload.sub === 'string' && payload.sub) return `user:${payload.sub}`;
      } catch {
        // invalid, expired or forged: counted against the address
      }
    }
    return ipOf(req);
  };
}

/** POST /auth/refresh: the refresh token presented (hashed), else the IP. */
export function refreshTracker(req: TrackedRequest): string {
  const fromBody = req.body && typeof req.body === 'object' ? (req.body as { refreshToken?: unknown }).refreshToken : undefined;
  const token = typeof fromBody === 'string' && fromBody ? fromBody : req.cookies?.[REFRESH_COOKIE_NAME];
  if (typeof token === 'string' && token.length > 0 && token.length < 4096) return `rt:${sha256(token)}`;
  return ipOf(req);
}

/** The per-IP ceiling's tracker. */
export const ipTracker = (req: TrackedRequest): string => ipOf(req);
