/**
 * The comparison of source rows with the directory — one implementation for the dry run (S2a),
 * recompare and apply (S2b), so all three produce exactly the same items, changes and report
 * digest. READ-ONLY: it reads the directory through the caller's transaction and writes nothing.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { directoryPlaces, normaliseNesaRow, type NormalisedRow } from './nesa-normaliser.js';
import { matchRows, type DirectorySnapshot, type MatchInput, type StagedChange, type StagedItem, type SyncResolution } from './sync-matcher.js';
import { countsOf, decisionsDigest, reportDigest } from './sync-report.js';

type Tx = Prisma.TransactionClient;
type Place = { province: string | null; district: string | null; sector: string | null };

/** One consistent read of the directory (inside the caller's transaction). */
export async function loadDirectorySnapshot(tx: Tx, dataSourceId: string): Promise<{ snap: DirectorySnapshot; places: Place[] }> {
  const schools = await tx.school.findMany({
    select: {
      id: true, name: true, nameKey: true, code: true, countryCode: true, province: true, district: true, sector: true,
      cell: true, village: true, accommodation: true, ownership: true, source: true, isActive: true,
    },
  });
  const externalIds = await tx.schoolExternalId.findMany({ where: { dataSourceId }, select: { externalKey: true, schoolId: true } });
  // Read only to avoid proposing a contact a school already has; never returned unmasked.
  const contacts = await tx.schoolContact.findMany({ where: { removedAt: null }, select: { schoolId: true, type: true, value: true } });
  const levels = await tx.schoolEducationLevel.findMany({ select: { schoolId: true, levelCode: true } });
  const links = await tx.schoolProgramme.findMany({ select: { schoolId: true, programmeId: true } });
  const programmes = await tx.programme.findMany({ select: { id: true, code: true, name: true, category: true, needsReview: true } });
  const group = <T>(rows: T[], key: (r: T) => string, value: (r: T) => string) => {
    const m = new Map<string, Set<string>>();
    for (const r of rows) { const k = key(r); if (!m.has(k)) m.set(k, new Set()); m.get(k)!.add(value(r)); }
    return m;
  };
  return {
    snap: {
      schools: schools.map((s) => ({ ...s, accommodation: s.accommodation ?? null })),
      externalIds: new Map(externalIds.map((e) => [e.externalKey, e.schoolId])),
      contacts: group(contacts, (c) => c.schoolId, (c) => `${c.type}|${c.value}`),
      levels: group(levels, (l) => l.schoolId, (l) => l.levelCode),
      programmeLinks: group(links, (l) => l.schoolId, (l) => l.programmeId),
      programmes,
    },
    places: schools.filter((s) => s.source === 'OFFICIAL_LIST' && s.countryCode === 'RW'),
  };
}

export interface SourceRowInput { row: number; sourceRef: string; raw: Record<string, string>; problems: string[] }

export interface Comparison {
  inputs: Array<MatchInput & { n: NormalisedRow }>;
  items: StagedItem[];
  changes: StagedChange[];
  reportDigest: string;
  /** The decisions digest with every change PENDING (a fresh comparison). */
  pendingDecisionsDigest: string;
  counts: ReturnType<typeof countsOf>;
}

/** Normalise and match the rows against the snapshot (with approved resolutions), and digest the result. */
export function compareRows(rows: readonly SourceRowInput[], snap: DirectorySnapshot, places: readonly Place[], resolutions?: ReadonlyMap<number, SyncResolution>): Comparison {
  const dir = directoryPlaces(places);
  const inputs = rows.map((r) => ({ ...r, n: normaliseNesaRow(r.raw, dir) }));
  const { items, changes } = matchRows(inputs, snap, resolutions);
  const rowOf = (i: number | null) => (i === null ? null : items[i].rowNumber);
  return {
    inputs, items, changes,
    reportDigest: reportDigest(items, changes.map((c) => ({ ...c, rowNumber: rowOf(c.itemIndex) }))),
    pendingDecisionsDigest: decisionsDigest(changes.map((c) => ({ ...c, rowNumber: rowOf(c.itemIndex), decision: 'PENDING' }))),
    counts: countsOf(items, changes),
  };
}

/** The staged rows of a run as comparison input (row problems are kept as CELL_UNREADABLE issues). */
export function stagedRows(items: ReadonlyArray<{ rowNumber: number | null; sourceRef: string | null; raw: unknown; issues: unknown }>): SourceRowInput[] {
  return items.filter((it) => it.rowNumber !== null).map((it) => ({
    row: it.rowNumber!, sourceRef: it.sourceRef!, raw: (it.raw ?? {}) as Record<string, string>,
    problems: ((it.issues ?? []) as Array<{ code: string; message: string }>).filter((x) => x.code === 'CELL_UNREADABLE').map((x) => x.message),
  })).sort((a, b) => a.row - b.row);
}

/** JSON with object keys sorted at every level (jsonb read back from PostgreSQL reorders keys). */
export function canonicalJson(v: unknown): string {
  const sort = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(sort);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]));
    return x === undefined ? null : x;
  };
  return JSON.stringify(sort(v));
}

/** A stable identity of a change across comparisons (row, kind, field, school and values). */
export function changeKey(c: { rowNumber: number | null; kind: string; field: string | null; schoolId: string | null; currentValue: unknown; publishedValue: unknown }): string {
  return canonicalJson([c.rowNumber, c.kind, c.field, c.schoolId, c.currentValue ?? null, c.publishedValue ?? null]);
}
