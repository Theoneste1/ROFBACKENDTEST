/**
 * School record rules (school administration PR B, owner-approved 2026-11-11).
 *
 * Rwanda (country "RW") uses the official directory: a school code is 6 digits whose first
 * digit is the province (M8): 1 Kigali City, 2 Southern, 3 Western, 4 Northern, 5 Eastern.
 * Codes and the province → district → sector directory are Rwanda only; a school in another
 * country never carries a code and never takes part in code or name matching.
 */
export const RWANDA = 'RW';

/** Province of each code prefix, exactly as stored by M8. */
export const PROVINCE_BY_CODE_PREFIX: Readonly<Record<string, string>> = {
  '1': 'Kigali City',
  '2': 'Southern Province',
  '3': 'Western Province',
  '4': 'Northern Province',
  '5': 'Eastern Province',
};

export const SCHOOL_CODE_PATTERN = /^\d{6}$/;

export const SCHOOL_OWNERSHIP = ['PUBLIC', 'GOVERNMENT_AIDED', 'PRIVATE'] as const;
export type SchoolOwnership = (typeof SCHOOL_OWNERSHIP)[number];

/** The province a Rwandan school code belongs to, or null when the code is malformed. */
export function provinceOfCode(code: string): string | null {
  if (!SCHOOL_CODE_PATTERN.test(code)) return null;
  return PROVINCE_BY_CODE_PREFIX[code[0]] ?? null;
}

/** A school name as stored: trimmed, inner whitespace collapsed (case and accents kept). */
export function cleanSchoolName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/** Problems with a code for a school in `province` (empty when valid). */
export function codeProblems(code: string, province: string | null | undefined): string[] {
  if (!SCHOOL_CODE_PATTERN.test(code)) return ['A school code is exactly 6 digits.'];
  const expected = provinceOfCode(code);
  if (!expected) return ['A school code starts with 1 (Kigali City), 2 (Southern), 3 (Western), 4 (Northern) or 5 (Eastern).'];
  if (province && province !== expected) return [`Code ${code} belongs to ${expected}, not ${province}.`];
  return [];
}
