/**
 * Matching source rows with the directory (school directory S2a; owner-approved 2026-11-11).
 * Pure: it reads a snapshot of the directory and returns staged items and proposed changes — it
 * never writes the directory.
 *
 * 1. INVALID: no name, an unknown province, no district or sector, or an unreadable cell. Kept.
 * 2. Disputed codes, over the whole file (B, D7) — never assigned, matched or turned into an
 *    external id:
 *      the same code with a different normalised name or place (province, district, sector,
 *      cell, village) → every row with it is a CONFLICT; only identical code + name + place rows
 *      are one school (the extra rows: DUPLICATE_ROW);
 *      a code whose first digit is another province's → CONFLICT.
 *    Rows without a usable code that share a fingerprint → CONFLICT (they cannot be told apart).
 * 3. Then, per row, the first that applies:
 *      a. the dataset's external id for the code;
 *      b. the school with that code — unless BOTH the normalised name and the district differ:
 *         CONFLICT (R2: no match, no code, no external id, no update);
 *      c. the dataset's external id for the fingerprint (current or superseded);
 *      d. a school with the same normalised name in the same district (or none recorded) →
 *         POSSIBLE_DUPLICATE (never merged);
 *      e. NEW.
 *    A school matched by two rows → both CONFLICT. A fingerprint match whose school has another
 *    code → CONFLICT.
 * 4. Proposed changes of a matched school, one per field: an empty field → FILL_EMPTY; a
 *    different value → CHANGE; never a clearing. The name: NAME_RESTORE only when the school is
 *    from the official list, matched by code, and its current name is exactly the published name
 *    + " — " + district or + " (" + code + ")" (M8's suffixes); otherwise CHANGE. Additions:
 *    ADD_CONTACT / ADD_LEVEL / ADD_PROGRAMME for what the school does not have yet.
 * 5. A NEW row → CREATE_SCHOOL (+ its additions). A place not in the directory → one NEW_PLACE
 *    per place. An official coded school whose code is nowhere in the file → MISSING_FROM_SOURCE
 *    (reported, never changed).
 */
import type { SchoolSyncChangeKind, SchoolSyncItemOutcome } from '../../generated/prisma/client.js';
import { schoolKey } from '../school-key.js';
import type { NormalisedRow, SyncIssue } from './nesa-normaliser.js';

export interface DirectorySchool {
  id: string; name: string; nameKey: string | null; code: string | null; countryCode: string;
  province: string | null; district: string | null; sector: string | null; cell: string | null; village: string | null;
  accommodation: string | null; ownership: string | null; source: string; isActive: boolean;
}

export interface DirectorySnapshot {
  schools: DirectorySchool[];
  /** The dataset's data source: externalKey → school. */
  externalIds: ReadonlyMap<string, string>;
  /** schoolId → "TYPE|value" of its active contacts. */
  contacts: ReadonlyMap<string, ReadonlySet<string>>;
  /** schoolId → its level codes. */
  levels: ReadonlyMap<string, ReadonlySet<string>>;
  /** schoolId → its programme ids. */
  programmeLinks: ReadonlyMap<string, ReadonlySet<string>>;
  programmes: ReadonlyArray<{ id: string; code: string | null; name: string; category: string; needsReview: boolean }>;
}

export interface MatchInput {
  row: number; sourceRef: string; raw: Record<string, string>; problems: string[]; n: NormalisedRow;
}

export interface StagedItem {
  index: number;
  rowNumber: number | null;
  sourceRef: string | null;
  raw: Record<string, string> | null;
  normalized: NormalisedRow | null;
  outcome: SchoolSyncItemOutcome;
  schoolId: string | null;
  matchedBy: string | null;
  conflictGroup: string | null;
  details: Record<string, unknown> | null;
  issues: SyncIssue[];
}

export interface StagedChange {
  itemIndex: number | null;
  schoolId: string | null;
  kind: SchoolSyncChangeKind;
  field: string | null;
  currentValue: unknown;
  publishedValue: unknown;
}

export interface MatchResult { items: StagedItem[]; changes: StagedChange[] }

/**
 * A reviewer's explicit resolution of a CONFLICT or POSSIBLE_DUPLICATE row (S2b), approved by a
 * Super Admin — never automatic. LINK: the row is the given school (its field differences become
 * ordinary proposed changes); CREATE: the row is a new school. `code`: an official code the
 * reviewer verified (a disputed code is otherwise never used).
 */
export type SyncResolutionAction = 'LINK' | 'CREATE';
export type SyncResolution =
  | { action: Extract<SyncResolutionAction, 'LINK'>; schoolId: string; code?: string | null }
  | { action: Extract<SyncResolutionAction, 'CREATE'>; code?: string | null };

const COMPARED_FIELDS = ['province', 'district', 'sector', 'cell', 'village', 'accommodation', 'ownership'] as const;
const lower = (v: string | null | undefined) => (v ?? '').toLowerCase();
const keyOf = (s: DirectorySchool) => s.nameKey ?? schoolKey(s.name);
const identity = (n: NormalisedRow) => [n.nameKey, n.province, n.district, n.sector, n.cell ?? '', n.village ?? ''].map((x) => lower(x)).join('|');

export function matchRows(inputs: MatchInput[], snap: DirectorySnapshot, resolutions?: ReadonlyMap<number, SyncResolution>): MatchResult {
  const byCode = new Map(snap.schools.filter((s) => s.code).map((s) => [s.code!, s]));
  const byId = new Map(snap.schools.map((s) => [s.id, s]));
  const byKey = new Map<string, DirectorySchool[]>();
  for (const s of snap.schools) {
    if (s.countryCode !== 'RW') continue;
    const k = keyOf(s);
    byKey.set(k, [...(byKey.get(k) ?? []), s]);
  }

  const items: StagedItem[] = inputs.map((x, index) => ({
    index, rowNumber: x.row, sourceRef: x.sourceRef, raw: x.raw, normalized: x.n,
    outcome: 'NEW', schoolId: null, matchedBy: null, conflictGroup: null, details: null,
    issues: [...x.n.issues, ...x.problems.map((p) => ({ code: 'CELL_UNREADABLE', field: p.split(':')[0], message: p }))],
  }));
  const conflict = (it: StagedItem, group: string, reason: string, extra: Record<string, unknown> = {}) => {
    it.outcome = 'CONFLICT'; it.conflictGroup = group; it.schoolId = null; it.matchedBy = null;
    it.details = { ...it.details, reasons: [...((it.details?.reasons as string[]) ?? []), reason], ...extra };
  };

  // 1. INVALID
  const BLOCKING = new Set(['NAME_MISSING', 'PROVINCE_UNKNOWN', 'DISTRICT_MISSING', 'SECTOR_MISSING']);
  for (const [i, it] of items.entries()) {
    if (inputs[i].problems.length || it.issues.some((x) => BLOCKING.has(x.code))) it.outcome = 'INVALID';
  }
  const live = () => items.filter((it) => it.outcome === 'NEW');

  // 2. Disputed codes (the whole file), then repeated fingerprints of rows without a code.
  const byFileCode = new Map<string, StagedItem[]>();
  for (const it of live()) {
    const n = it.normalized!;
    if (n.code) byFileCode.set(n.code, [...(byFileCode.get(n.code) ?? []), it]);
  }
  for (const [code, group] of byFileCode) {
    const mismatch = group.some((it) => it.normalized!.codeStatus === 'PROVINCE_MISMATCH');
    const identical = new Set(group.map((it) => identity(it.normalized!))).size === 1;
    if (mismatch) { for (const it of group) conflict(it, `code:${code}`, 'CODE_PROVINCE_MISMATCH', { code }); continue; }
    if (group.length > 1 && !identical) {
      for (const it of group) conflict(it, `code:${code}`, 'CODE_REPEATED_WITH_DIFFERENT_SCHOOL', { code, rows: group.map((g) => g.rowNumber) });
      continue;
    }
    for (const dup of group.slice(1)) {
      dup.outcome = 'DUPLICATE_ROW';
      dup.details = { duplicateOfRow: group[0].rowNumber, code };
    }
  }
  const byFingerprint = new Map<string, StagedItem[]>();
  for (const it of live()) {
    const n = it.normalized!;
    if (!n.code && n.fingerprint) byFingerprint.set(n.fingerprint, [...(byFingerprint.get(n.fingerprint) ?? []), it]);
  }
  for (const group of byFingerprint.values()) {
    if (group.length > 1) for (const it of group) conflict(it, `fingerprint:${group[0].rowNumber}`, 'FINGERPRINT_REPEATED', { rows: group.map((g) => g.rowNumber) });
  }

  // 3. Matching.
  for (const it of live()) {
    const n = it.normalized!;
    if (n.code) {
      const viaExternal = snap.externalIds.get(n.code);
      const holder = byCode.get(n.code);
      if (viaExternal && holder && holder.id !== viaExternal) { conflict(it, `code:${n.code}`, 'CODE_IDENTITY_MISMATCH', { code: n.code }); continue; }
      const school = (viaExternal && byId.get(viaExternal)) || holder;
      if (school) {
        if (keyOf(school) !== n.nameKey && lower(school.district) !== lower(n.district)) {
          conflict(it, `code:${n.code}`, 'CODE_MATCHES_A_DIFFERENT_SCHOOL', { code: n.code, schoolId: school.id });
          continue;
        }
        const fpOwner = n.fingerprint ? snap.externalIds.get(n.fingerprint) : undefined;
        if (fpOwner && fpOwner !== school.id) {
          conflict(it, `code:${n.code}`, 'FINGERPRINT_BELONGS_TO_ANOTHER_SCHOOL', { code: n.code, schoolId: school.id, fingerprintSchoolId: fpOwner });
          continue;
        }
        it.outcome = 'MATCHED'; it.schoolId = school.id; it.matchedBy = viaExternal ? 'EXTERNAL_ID_CODE' : 'CODE';
        continue;
      }
    }
    const viaFingerprint = n.fingerprint ? snap.externalIds.get(n.fingerprint) : undefined;
    const fpSchool = viaFingerprint ? byId.get(viaFingerprint) : undefined;
    if (fpSchool) {
      if (n.code && fpSchool.code && fpSchool.code !== n.code) {
        conflict(it, `code:${n.code}`, 'CODE_DIFFERS_FROM_MATCHED_SCHOOL', { code: n.code, schoolId: fpSchool.id });
        continue;
      }
      it.outcome = 'MATCHED'; it.schoolId = fpSchool.id; it.matchedBy = 'FINGERPRINT';
      continue;
    }
    const candidates = (byKey.get(n.nameKey!) ?? []).filter((s) => s.district === null || lower(s.district) === lower(n.district));
    if (candidates.length) {
      it.outcome = 'POSSIBLE_DUPLICATE';
      it.details = {
        candidates: candidates.slice(0, 20).map((s) => ({
          id: s.id, name: s.name, code: s.code, district: s.district, sector: s.sector, isActive: s.isActive, source: s.source,
        })),
      };
    }
  }

  // Approved resolutions (S2b): only for CONFLICT and POSSIBLE_DUPLICATE rows, only as approved.
  if (resolutions) {
    for (const it of items) {
      const res = it.rowNumber !== null ? resolutions.get(it.rowNumber) : undefined;
      if (!res || (it.outcome !== 'CONFLICT' && it.outcome !== 'POSSIBLE_DUPLICATE')) continue;
      const resolvedFrom = it.outcome;
      it.details = { ...it.details, resolvedFrom, resolution: res, codeDisputed: resolvedFrom === 'CONFLICT' };
      if (res.action === 'CREATE') { it.outcome = 'NEW'; it.schoolId = null; it.matchedBy = null; continue; }
      const school = byId.get(res.schoolId);
      const fp = it.normalized!.fingerprint;
      const fpOwner = fp ? snap.externalIds.get(fp) : undefined;
      if (!school) { it.details = { ...it.details, resolutionProblem: 'SCHOOL_NOT_FOUND' }; continue; }
      if (fpOwner && fpOwner !== school.id) { it.details = { ...it.details, resolutionProblem: 'FINGERPRINT_BELONGS_TO_ANOTHER_SCHOOL' }; continue; }
      it.outcome = 'MATCHED'; it.schoolId = school.id; it.matchedBy = 'REVIEW';
    }
  }

  // A school matched by two rows.
  const matchedBy = new Map<string, StagedItem[]>();
  for (const it of items) if (it.outcome === 'MATCHED') matchedBy.set(it.schoolId!, [...(matchedBy.get(it.schoolId!) ?? []), it]);
  for (const [schoolId, group] of matchedBy) {
    if (group.length > 1) for (const it of group) conflict(it, `school:${schoolId}`, 'SCHOOL_MATCHED_TWICE', { schoolId, rows: group.map((g) => g.rowNumber) });
  }
  // Duplicate rows follow their first row.
  const byRow = new Map(items.map((it) => [it.rowNumber, it]));
  for (const it of items) {
    if (it.outcome !== 'DUPLICATE_ROW') continue;
    const first = byRow.get(it.details!.duplicateOfRow as number);
    it.schoolId = first?.outcome === 'MATCHED' ? first.schoolId : null;
  }

  // 4–5. Proposed changes.
  const changes: StagedChange[] = [];
  const claimedCodes = new Set(byCode.keys());
  const newPlaces = new Map<string, { value: Record<string, unknown>; rows: number[] }>();
  for (const it of items) {
    const n = it.normalized;
    if (!n || (it.outcome !== 'MATCHED' && it.outcome !== 'NEW')) continue;
    if (!n.placeKnown && n.province && n.district && n.sector) {
      const k = lower(`${n.province}|${n.district}|${n.sector}`);
      const place = newPlaces.get(k) ?? { value: { province: n.province, district: n.district, sector: n.sector, publishedSpelling: n.publishedPlace }, rows: [] };
      place.rows.push(it.rowNumber!);
      newPlaces.set(k, place);
    }
    // The code a change may carry: a reviewer-verified code, else the row's own valid, unclaimed,
    // undisputed code — never a disputed one (D7).
    const resolution = it.details?.resolution as SyncResolution | undefined;
    const rowCode = !it.details?.codeDisputed && n.codeStatus === 'VALID' && !claimedCodes.has(n.code!) ? n.code : null;
    const wantedCode = resolution?.code ?? rowCode;
    if (it.outcome === 'NEW') {
      changes.push({
        itemIndex: it.index, schoolId: null, kind: 'CREATE_SCHOOL', field: null, currentValue: null,
        publishedValue: {
          name: n.name, code: wantedCode,
          province: n.province, district: n.district, sector: n.sector, cell: n.cell, village: n.village,
          accommodation: n.accommodation, ownership: n.ownership, newPlace: !n.placeKnown,
        },
      });
      additions(changes, it, n, null, snap);
      continue;
    }
    const s = byId.get(it.schoolId!)!;
    if (!s.isActive) it.issues.push({ code: 'SCHOOL_INACTIVE', field: 'School Name', message: 'The matched school is inactive (it is never reactivated by a sync).' });
    if (n.name && s.name !== n.name) {
      const restore = s.source === 'OFFICIAL_LIST' && (it.matchedBy === 'CODE' || it.matchedBy === 'EXTERNAL_ID_CODE')
        && (s.name === `${n.name} — ${s.district}` || (s.code !== null && s.name === `${n.name} (${s.code})`));
      changes.push({ itemIndex: it.index, schoolId: s.id, kind: restore ? 'NAME_RESTORE' : 'CHANGE', field: 'name', currentValue: s.name, publishedValue: n.name });
    }
    for (const f of COMPARED_FIELDS) {
      const published = n[f];
      const current = s[f];
      if (published === null || published === current) continue;
      changes.push({ itemIndex: it.index, schoolId: s.id, kind: current === null ? 'FILL_EMPTY' : 'CHANGE', field: f, currentValue: current, publishedValue: published });
    }
    if (wantedCode && s.code === null) {
      changes.push({ itemIndex: it.index, schoolId: s.id, kind: 'FILL_EMPTY', field: 'code', currentValue: null, publishedValue: wantedCode });
    } else if (resolution?.code && s.code !== resolution.code) {
      changes.push({ itemIndex: it.index, schoolId: s.id, kind: 'CHANGE', field: 'code', currentValue: s.code, publishedValue: resolution.code });
    }
    additions(changes, it, n, s.id, snap);
  }
  for (const place of newPlaces.values()) {
    changes.push({ itemIndex: null, schoolId: null, kind: 'NEW_PLACE', field: 'place', currentValue: null, publishedValue: { ...place.value, rowCount: place.rows.length, rows: place.rows.slice(0, 100) } });
  }

  // MISSING_FROM_SOURCE: official coded schools whose code appears nowhere in the file.
  const fileCodes = new Set(inputs.map((x) => x.n.rawCode));
  const matchedSchools = new Set(items.filter((it) => it.schoolId).map((it) => it.schoolId));
  for (const s of snap.schools) {
    if (s.source !== 'OFFICIAL_LIST' || s.countryCode !== 'RW' || !s.code || fileCodes.has(s.code) || matchedSchools.has(s.id)) continue;
    items.push({
      index: items.length, rowNumber: null, sourceRef: null, raw: null, normalized: null, outcome: 'MISSING_FROM_SOURCE',
      schoolId: s.id, matchedBy: null, conflictGroup: null,
      details: { code: s.code, name: s.name, district: s.district, sector: s.sector, isActive: s.isActive }, issues: [],
    });
  }
  return { items, changes };
}

function additions(changes: StagedChange[], it: StagedItem, n: NormalisedRow, schoolId: string | null, snap: DirectorySnapshot) {
  const contacts = schoolId ? snap.contacts.get(schoolId) : undefined;
  for (const c of n.contacts) {
    if (contacts?.has(`${c.type}|${c.value}`)) continue;
    changes.push({ itemIndex: it.index, schoolId, kind: 'ADD_CONTACT', field: c.type, currentValue: null, publishedValue: { type: c.type, value: c.value } });
  }
  const levels = schoolId ? snap.levels.get(schoolId) : undefined;
  for (const l of n.levels) {
    if (levels?.has(l.code)) continue;
    changes.push({ itemIndex: it.index, schoolId, kind: 'ADD_LEVEL', field: l.code, currentValue: null, publishedValue: l });
  }
  const links = schoolId ? snap.programmeLinks.get(schoolId) : undefined;
  for (const p of n.programmes) {
    const ref = snap.programmes.find((x) => (p.code && x.code && x.code.toUpperCase() === p.code.toUpperCase())
      || (!p.code && x.category === p.category && x.name.toUpperCase() === p.name.toUpperCase()));
    if (ref && links?.has(ref.id)) continue;
    changes.push({
      itemIndex: it.index, schoolId, kind: 'ADD_PROGRAMME', field: p.code ?? p.name, currentValue: null,
      publishedValue: { ...p, programmeId: ref?.id ?? null, isNew: !ref, needsReview: ref ? ref.needsReview : true },
    });
  }
}
