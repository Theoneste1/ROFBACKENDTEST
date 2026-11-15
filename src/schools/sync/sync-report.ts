/**
 * Sync run reports (school directory S2a): digests, counts, the reconciliation with the source's
 * own totals, and what an API response may show of staged values (contact values masked — C).
 */
import { createHash } from 'node:crypto';

import { maskContact, maskRawRow } from '../directory/school-contacts.js';
import type { NormalisedRow } from './nesa-normaliser.js';
import type { SourceSummaryLine } from './source-file.js';
import type { StagedChange, StagedItem } from './sync-matcher.js';

const sha256 = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** The comparison as reviewed: every item's outcome and match, every change's kind, field and values. */
export function reportDigest(items: ReadonlyArray<Pick<StagedItem, 'rowNumber' | 'outcome' | 'schoolId' | 'matchedBy' | 'conflictGroup'>>,
  changes: ReadonlyArray<Pick<StagedChange, 'kind' | 'field' | 'schoolId' | 'currentValue' | 'publishedValue'> & { rowNumber: number | null }>): string {
  const i = items.map((x) => [x.rowNumber, x.outcome, x.schoolId, x.matchedBy, x.conflictGroup])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const c = changes.map((x) => [x.rowNumber, x.kind, x.field, x.schoolId, x.currentValue ?? null, x.publishedValue ?? null])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return sha256({ v: 1, items: i, changes: c });
}

/** Every change's decision (S2b binds review tokens to it). */
export function decisionsDigest(changes: ReadonlyArray<{ kind: string; field: string | null; schoolId: string | null; rowNumber: number | null; decision: string }>): string {
  return sha256({ v: 1, decisions: changes.map((x) => [x.rowNumber, x.kind, x.field, x.schoolId, x.decision]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
}

export function countsOf(items: readonly StagedItem[], changes: readonly StagedChange[]) {
  const outcomes: Record<string, number> = {};
  for (const it of items) outcomes[it.outcome] = (outcomes[it.outcome] ?? 0) + 1;
  const kinds: Record<string, number> = {};
  for (const c of changes) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  const changed = new Set(changes.filter((c) => c.itemIndex !== null).map((c) => c.itemIndex));
  const unchanged = items.filter((it) => it.outcome === 'MATCHED' && !changed.has(it.index)).length;
  const issues: Record<string, number> = {};
  for (const it of items) for (const x of it.issues) issues[x.code] = (issues[x.code] ?? 0) + 1;
  return { sourceRows: items.filter((it) => it.rowNumber !== null).length, outcomes, changes: kinds, unchanged, issues };
}

const PROVINCE_LABEL: Readonly<Record<string, string>> = {
  east: 'Eastern Province', eastern: 'Eastern Province', 'eastern province': 'Eastern Province',
  north: 'Northern Province', northern: 'Northern Province', 'northern province': 'Northern Province',
  south: 'Southern Province', southern: 'Southern Province', 'southern province': 'Southern Province',
  west: 'Western Province', western: 'Western Province', 'western province': 'Western Province',
  kigali: 'Kigali City', 'kigali city': 'Kigali City',
};

/** The source's own totals (its summary sheet) against the rows read: total, provinces, districts. */
export function reconcile(summary: readonly SourceSummaryLine[] | null, rows: ReadonlyArray<NormalisedRow>) {
  if (!summary) return { summaryAvailable: false, rowsRead: rows.length, checks: [], mismatches: 0 };
  const byProvince = new Map<string, number>();
  const byDistrict = new Map<string, number>();
  for (const r of rows) {
    if (r.province) byProvince.set(r.province, (byProvince.get(r.province) ?? 0) + 1);
    if (r.district) byDistrict.set(r.district.toLowerCase(), (byDistrict.get(r.district.toLowerCase()) ?? 0) + 1);
  }
  const checks: Array<{ label: string; source: number; read: number; matches: boolean }> = [];
  for (const line of summary) {
    const label = line.label.trim();
    const l = label.toLowerCase();
    let read: number | undefined;
    if (/^(grand\s+)?total\b/.test(l) || /total (number of )?schools/.test(l)) read = rows.length;
    else if (PROVINCE_LABEL[l]) read = byProvince.get(PROVINCE_LABEL[l]) ?? 0;
    else if (byDistrict.has(l)) read = byDistrict.get(l);
    if (read === undefined) continue;
    checks.push({ label, source: line.value, read, matches: line.value === read });
  }
  return { summaryAvailable: true, rowsRead: rows.length, checks, mismatches: checks.filter((c) => !c.matches).length };
}

// ─── What responses show (C: never a contact value) ──────────────────────────

/** A normalised row as shown: contacts masked. */
export function maskNormalized(n: unknown): unknown {
  if (!n || typeof n !== 'object') return n;
  const row = n as NormalisedRow;
  return { ...row, contacts: (row.contacts ?? []).map((c) => ({ type: c.type, masked: maskContact(c.type, c.value) })) };
}

/** A change's staged value as shown: an ADD_CONTACT's value masked; others as staged. */
export function maskChangeValue(kind: string, value: unknown): unknown {
  if (kind !== 'ADD_CONTACT' || !value || typeof value !== 'object') return value;
  const c = value as { type: 'EMAIL' | 'PHONE'; value: string };
  return { type: c.type, masked: maskContact(c.type, c.value) };
}

export const maskRaw = maskRawRow;
