/**
 * Sign-in protection (owner approval 2026-11-18, SIGN-IN-RATE-LIMIT-PROPOSAL.md).
 *
 * Two independent limits per attempt, both checked BEFORE the account is looked up, so a username that exists and one
 * that does not are treated identically (no account oracle):
 *  - per normalised username (trimmed, lower-case — usernames and e-mail addresses alike): 5 attempts a minute and
 *    20 an hour, from any address → 429;
 *  - per address: 60 attempts a minute — the throttler on POST /auth/login (not here).
 * And a lock scoped to the username AND the address: 5 consecutive wrong passwords for one username from one address
 * lock that pair for 15 minutes. While locked, that address gets the same answer as a wrong password (the right password
 * included); every other address — the student's own school, home — can still sign in. A correct password clears the
 * pair. Unknown usernames are counted and locked exactly like real ones.
 *
 * Keys are HMACs (server secret) of the normalised username, so the store never holds usernames. Every check-and-record
 * runs synchronously (no await between them), so concurrent guesses cannot all pass a stale check in this process.
 * The store is in memory: correct for one backend instance (today's deployment); several instances would need a shared
 * store (noted in the proposal).
 */
import { createHmac } from 'node:crypto';

export const LOGIN_PER_USERNAME_PER_MINUTE = 5;
export const LOGIN_PER_USERNAME_PER_HOUR = 20;
export const LOGIN_PER_ADDRESS_PER_MINUTE = 60;
export const LOGIN_FAILURES_BEFORE_LOCK = 5;
export const LOGIN_LOCK_MS = 15 * 60_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type LoginDecision =
  | { ok: true; pair: string }
  | { ok: false; reason: 'RATE_LIMITED'; retryAfterSeconds: number }
  | { ok: false; reason: 'LOCKED'; pair: string };

interface PairState { failures: number; lockedUntil: number }

export class LoginLimiter {
  private readonly attempts = new Map<string, number[]>();   // username key → attempt times (last hour)
  private readonly pairs = new Map<string, PairState>();     // username key + address → failures / lock
  private lastSweep = 0;

  constructor(
    private readonly secret: string,
    /** Test switch (NODE_ENV=test and THROTTLE_DISABLED=true): the username rate windows are not applied. Locks are. */
    private readonly windowsDisabled: () => boolean = () => false,
    private readonly now: () => number = Date.now,
    /**
     * Whether req.ip is the visitor's own address (SIGNIN_TRUSTED_CLIENT_ADDRESS=true, set only once the deployment's
     * client address is verified). Off by default: behind a shared proxy (Render's Cloudflare edge, staging evidence
     * 2026-11-18) the "known address" exemption would also cover attackers routed through the same edge.
     */
    private readonly addressesTrusted: () => boolean = () => false,
  ) {}

  /** Whether an address may be treated as the account owner's own (the known-address exemption). */
  get trustsClientAddresses(): boolean {
    return this.addressesTrusted();
  }

  /** HMAC of the normalised identifier (username or e-mail). */
  key(identifier: string): string {
    return createHmac('sha256', this.secret).update(identifier.trim().toLowerCase()).digest('hex');
  }

  /** Decide one attempt and, when it may proceed, record it. Synchronous by design (see the header). */
  reserve(identifier: string, address: string | undefined): LoginDecision {
    const t = this.now();
    this.sweep(t);
    const user = this.key(identifier);
    const pair = `${user}|${address ?? 'unknown'}`;
    const state = this.pairs.get(pair);
    if (state && state.lockedUntil > t) return { ok: false, reason: 'LOCKED', pair };
    if (!this.windowsDisabled()) {
      const recent = (this.attempts.get(user) ?? []).filter((x) => x > t - HOUR);
      const lastMinute = recent.filter((x) => x > t - MINUTE);
      if (lastMinute.length >= LOGIN_PER_USERNAME_PER_MINUTE) {
        return { ok: false, reason: 'RATE_LIMITED', retryAfterSeconds: Math.max(1, Math.ceil((lastMinute[0] + MINUTE - t) / 1000)) };
      }
      if (recent.length >= LOGIN_PER_USERNAME_PER_HOUR) {
        return { ok: false, reason: 'RATE_LIMITED', retryAfterSeconds: Math.max(1, Math.ceil((recent[0] + HOUR - t) / 1000)) };
      }
      recent.push(t);
      this.attempts.set(user, recent);
    }
    return { ok: true, pair };
  }

  /**
   * An address this account signed in from before (the caller checked): the username windows do not apply, the lock
   * of this username + address does.
   */
  reserveKnownAddress(identifier: string, address: string | undefined): LoginDecision {
    const pair = `${this.key(identifier)}|${address ?? 'unknown'}`;
    const state = this.pairs.get(pair);
    if (state && state.lockedUntil > this.now()) return { ok: false, reason: 'LOCKED', pair };
    return { ok: true, pair };
  }

  /** A wrong password (or unknown username) for this pair. Returns true when this failure locked the pair. */
  failed(pair: string): boolean {
    const t = this.now();
    const s = this.pairs.get(pair) ?? { failures: 0, lockedUntil: 0 };
    if (s.lockedUntil > t) return false;
    s.failures += 1;
    let lockedNow = false;
    if (s.failures >= LOGIN_FAILURES_BEFORE_LOCK) {
      s.failures = 0;
      s.lockedUntil = t + LOGIN_LOCK_MS;
      lockedNow = true;
    }
    this.pairs.set(pair, s);
    return lockedNow;
  }

  /** A correct password from this pair: its failures and lock are cleared. */
  succeeded(pair: string): void {
    this.pairs.delete(pair);
  }

  /** Every lock and failure count of this identifier, from every address (e.g. after a password reset). */
  clear(identifier: string): void {
    const prefix = `${this.key(identifier)}|`;
    for (const k of this.pairs.keys()) if (k.startsWith(prefix)) this.pairs.delete(k);
  }

  private sweep(t: number) {
    if (t - this.lastSweep < MINUTE) return;
    this.lastSweep = t;
    for (const [k, times] of this.attempts) {
      const kept = times.filter((x) => x > t - HOUR);
      if (kept.length) this.attempts.set(k, kept); else this.attempts.delete(k);
    }
    for (const [k, s] of this.pairs) if (s.lockedUntil <= t && s.failures === 0) this.pairs.delete(k);
  }
}
