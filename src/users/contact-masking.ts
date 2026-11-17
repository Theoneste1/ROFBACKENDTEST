/**
 * Data minimisation for lists (ACC-16 / SEC-03, 2026-11-17): a phone number in a list of users is shown masked —
 * Rwanda's country code (other countries: "+") and the last three digits only, e.g. "+250••••••456". The full number is returned only for one
 * account at a time (GET /admin/users/:id, users.manage) and to the account holder (GET /me). Pure; unit-tested.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 6) return '•••';
  // Rwanda keeps its country code; elsewhere only "+" (a guessed code could reveal an area code).
  const cc = phone.startsWith('+250') ? '+250' : phone.startsWith('+') ? '+' : '';
  const shown = digits.slice(-3);
  const hidden = Math.max(digits.length - (cc === '+250' ? 3 : 0) - 3, 3);
  return `${cc}${'•'.repeat(hidden)}${shown}`;
}

/** A list row with its phone numbers masked (other fields unchanged). */
export function maskContacts<T extends { phone?: string | null; guardianPhone?: string | null }>(row: T): T {
  return {
    ...row,
    ...(row.phone !== undefined && { phone: maskPhone(row.phone) }),
    ...(row.guardianPhone !== undefined && { guardianPhone: maskPhone(row.guardianPhone) }),
  };
}
