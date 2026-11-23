/**
 * News subscribers (owner 2026-11-23): the pure rules — e-mail normalisation, the unsubscribe token, the
 * unsubscribe links and the mailing audience. No database or framework code here, so each rule is unit-tested.
 *
 * Unsubscribe token: HMAC-SHA256(JWT_SECRET, "subscriber-unsubscribe:" + subscriber id), base64url. Nothing is
 * stored: the server recomputes it. Changing JWT_SECRET makes earlier links invalid (the person then
 * unsubscribes from a newer e-mail, or asks an Administrator).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { OlympiadSubject, Prisma, SubscriberKind } from '../generated/prisma/client.js';

/** Mailing deliveries wait this long before the outbox may send them, so a mistaken mailing can still be cancelled. */
export const MAILING_SEND_DELAY_MS = 2 * 60_000;

/** At most this many rows in one CSV import. */
export const IMPORT_MAX_ROWS = 5_000;
export const IMPORT_MAX_BYTES = 1024 * 1024;

const TOKEN_PURPOSE = 'subscriber-unsubscribe:';

/** Trimmed, Unicode-normalised, lower-case. The only form an address is stored or compared in. */
export function normaliseEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase();
}

/** A deliberately simple check (one @, a dot in the domain, no spaces, at most 254 characters). */
export function looksLikeEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function unsubscribeToken(secret: string, subscriberId: string): string {
  return createHmac('sha256', secret).update(TOKEN_PURPOSE + subscriberId).digest('base64url');
}

/** Constant-time comparison; false for anything malformed. */
export function verifyUnsubscribeToken(secret: string, subscriberId: string, token: unknown): boolean {
  if (typeof token !== 'string' || token.length === 0 || token.length > 100) return false;
  const expected = Buffer.from(unsubscribeToken(secret, subscriberId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export interface UnsubscribeLinks {
  /** The frontend page with the Unsubscribe button (in every e-mail footer). */
  pageUrl: string | null;
  /** RFC 8058 one-click target (POST, no page), only when the API's public address is configured. */
  oneClickUrl: string | null;
}

export function unsubscribeLinks(opts: { secret: string; appUrl?: string | null; apiPublicUrl?: string | null }, subscriberId: string): UnsubscribeLinks {
  const q = `s=${encodeURIComponent(subscriberId)}&t=${encodeURIComponent(unsubscribeToken(opts.secret, subscriberId))}`;
  const base = (u?: string | null) => (u && /^https?:\/\//i.test(u) ? u.replace(/\/+$/, '') : null);
  const app = base(opts.appUrl);
  const api = base(opts.apiPublicUrl);
  return {
    pageUrl: app ? `${app}/unsubscribe?${q}` : null,
    oneClickUrl: api ? `${api}/api/v1/public/unsubscribe/one-click?${q}` : null,
  };
}

/**
 * The List-Unsubscribe headers (RFC 2369 / RFC 8058). One-click (List-Unsubscribe-Post) is only announced with an
 * https target that accepts the POST; otherwise the page link alone (mail clients open it).
 */
export function listUnsubscribeHeaders(links: UnsubscribeLinks): Record<string, string> {
  if (links.oneClickUrl && /^https:\/\//i.test(links.oneClickUrl)) {
    return { 'List-Unsubscribe': `<${links.oneClickUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  }
  return links.pageUrl ? { 'List-Unsubscribe': `<${links.pageUrl}>` } : {};
}

export interface Audience {
  interests?: OlympiadSubject[];
  kinds?: SubscriberKind[];
  countries?: string[];
}

/** The audience as stored: only non-empty lists, values de-duplicated and sorted, countries upper-case. */
export function normaliseAudience(a: Audience | undefined | null): Audience {
  const clean = <T extends string>(xs: T[] | undefined) => [...new Set(xs ?? [])].sort() as T[];
  const out: Audience = {};
  const interests = clean(a?.interests);
  const kinds = clean(a?.kinds);
  const countries = clean((a?.countries ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean));
  if (interests.length) out.interests = interests;
  if (kinds.length) out.kinds = kinds;
  if (countries.length) out.countries = countries;
  return out;
}

/**
 * Who receives a mailing: ACTIVE subscribers only, and
 *  - interests: someone with at least one of them, or who chose no interest (= every subject);
 *  - kinds: someone of one of those kinds (no kind given → not matched while a kind is required);
 *  - countries: someone in one of those countries.
 * An empty audience is every active subscriber.
 */
export function audienceWhere(a: Audience): Prisma.SubscriberWhereInput {
  const and: Prisma.SubscriberWhereInput[] = [{ status: 'ACTIVE' }];
  if (a.interests?.length) and.push({ OR: [{ interests: { hasSome: a.interests } }, { interests: { isEmpty: true } }] });
  if (a.kinds?.length) and.push({ kind: { in: a.kinds } });
  if (a.countries?.length) and.push({ country: { in: a.countries } });
  return { AND: and };
}

/** "Hello Ada," from "Ada Lovelace"; "Hello," without a name. */
export function greetingFor(fullName: string | null | undefined): string {
  const first = fullName?.trim().split(/\s+/)[0];
  return first ? `Hello ${first},` : 'Hello,';
}
