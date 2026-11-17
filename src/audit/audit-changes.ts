/**
 * Previous and new values for an audit entry (AUD-02): `{ field: { from, to } }` for the fields that actually changed.
 * Dates are stored as ISO strings, arrays and objects are compared by value, and long text is cut to
 * AUDIT_TEXT_LIMIT characters (the full text stays on the record; the audit says what it was and what it became).
 * Callers list the fields: never pass passwords, tokens, e-mail addresses or phone numbers here.
 */
export const AUDIT_TEXT_LIMIT = 500;

export type AuditValue = string | number | boolean | null | AuditValue[] | { [k: string]: AuditValue };
export type AuditChanges = Record<string, { from: AuditValue; to: AuditValue }>;

function norm(v: unknown): AuditValue {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v.length > AUDIT_TEXT_LIMIT ? `${v.slice(0, AUDIT_TEXT_LIMIT)}…` : v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'object' && 'toFixed' in (v as object)) return String(v); // Prisma Decimal
  return v as AuditValue;
}

const same = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Changed fields only; a field missing from `after` (undefined) was not part of the change. */
export function auditChanges<T extends object>(before: T, after: Partial<T>, fields: ReadonlyArray<keyof T & string>): AuditChanges {
  const out: AuditChanges = {};
  for (const f of fields) {
    const next = (after as Record<string, unknown>)[f];
    if (next === undefined) continue;
    const prev = (before as Record<string, unknown>)[f];
    if (!same(prev, next)) out[f] = { from: norm(prev), to: norm(next) };
  }
  return out;
}
