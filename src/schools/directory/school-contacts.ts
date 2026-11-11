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
  if (!raw) return { problem: 'The value is empty.' };
  if (type === 'EMAIL') {
    const value = raw.toLowerCase();
    return EMAIL.test(value) && value.length <= 200 ? { value } : { problem: `"${raw}" is not an e-mail address.` };
  }
  if (type === 'PHONE') {
    const value = normalisePhone(raw);
    return value ? { value } : { problem: `"${raw}" is not a phone number (Rwanda: 07XXXXXXXX or +2507XXXXXXXX; elsewhere: +country number).` };
  }
  return { value: raw.replace(/\s+/g, ' ') };
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
