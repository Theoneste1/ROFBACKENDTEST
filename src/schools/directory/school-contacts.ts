/**
 * School contacts (school directory S1, M12): normalisation of what an Administrator enters.
 * E-mail: trimmed, lower-case. Phone: E.164 (Rwandan numbers written locally become +250…).
 * The value as entered is kept as rawValue. Source quirks (N/A, "No Primary", the letter O for a
 * zero) are the directory sync's concern (S2): they stay in the source record, never here.
 */
import type { SchoolContactType } from '../../generated/prisma/client.js';

export type ContactNormalisation = { value: string } | { problem: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Separators people write inside phone numbers. */
const PHONE_SEPARATORS = /[\s().\-/]/g;

export function normaliseContact(type: SchoolContactType, input: string): ContactNormalisation {
  const raw = input.trim();
  if (!raw) return { problem: 'the value is empty.' };
  if (type === 'EMAIL') {
    const value = raw.toLowerCase();
    // Problems never repeat the value (M1: contact values appear only in the Administrator contact routes' data).
    return EMAIL.test(value) && value.length <= 200 ? { value } : { problem: 'not an e-mail address.' };
  }
  if (type === 'PHONE') {
    const value = normalisePhone(raw);
    return value ? { value } : { problem: 'not a phone number (Rwanda: 07XXXXXXXX or +2507XXXXXXXX; elsewhere: +country number).' };
  }
  return { value: raw.replace(/\s+/g, ' ') };
}

const HIDDEN = '•••';

/**
 * What an audit entry (and anything outside the Administrator contact routes) may show of a
 * contact: never the value itself. E-mail: first letter of the name and of the domain, and the
 * top-level domain (h•••@g•••.rw). Phone: the country code and the last two digits
 * (+250•••56). Other: the first character.
 */
export function maskContact(type: SchoolContactType, value: string): string {
  if (type === 'EMAIL') {
    const [local = '', domain = ''] = value.split('@');
    const tld = domain.includes('.') ? domain.slice(domain.lastIndexOf('.')) : '';
    return `${local.slice(0, 1)}${HIDDEN}@${domain.slice(0, 1)}${HIDDEN}${tld}`;
  }
  if (type === 'PHONE') return value.length > 6 ? `${value.slice(0, 4)}${HIDDEN}${value.slice(-2)}` : HIDDEN;
  return `${value.slice(0, 1)}${HIDDEN}`;
}

const EMAIL_IN_TEXT = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/gi;
/** A run of digits (with the separators people write) long enough to be a phone number: 9+ digits. */
const PHONE_IN_TEXT = /\+?\d[\d\s().\-/]{7,}\d/g;
const PHONE_MIN_DIGITS = 9;

/**
 * Free text recorded with a contact change (the Administrator's reason): every e-mail address and
 * phone number in it is masked like a contact value, the rest is kept for accountability.
 * Dates, school codes and other short numbers (fewer than 9 digits) are left as written.
 */
export function redactContactText(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  const out = text
    .replace(EMAIL_IN_TEXT, (m) => { redacted = true; return maskContact('EMAIL', m.toLowerCase()); })
    .replace(PHONE_IN_TEXT, (m) => {
      const digits = m.replace(/\D/g, '');
      if (digits.length < PHONE_MIN_DIGITS) return m;
      redacted = true;
      return maskContact('PHONE', normalisePhone(m) ?? `+${digits}`);
    });
  return { text: out, redacted };
}

/** E.164, or null. Rwanda: 9 national digits starting with 2 (landline) or 7 (mobile). */
export function normalisePhone(raw: string): string | null {
  let s = raw.replace(PHONE_SEPARATORS, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^0[27]\d{8}$/.test(s)) return `+250${s.slice(1)}`;
  if (/^250[27]\d{8}$/.test(s)) return `+${s}`;
  if (/^[27]\d{8}$/.test(s)) return `+250${s}`;
  if (s.startsWith('+250')) return /^\+250[27]\d{8}$/.test(s) ? s : null;
  return /^\+[1-9]\d{7,14}$/.test(s) ? s : null;
}
