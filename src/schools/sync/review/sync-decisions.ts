/**
 * Review decisions on a sync run's proposed changes (S2b; owner-approved 2026-11-11). Pure.
 *
 *   individual   any kind; CHANGE, ADD_CONTACT and NEW_PLACE ONLY individually;
 *                RESOLVE_CONFLICT only by a Super Admin (schools.syncDirectory)
 *   category     FILL_EMPTY, ADD_LEVEL, ADD_PROGRAMME, CREATE_SCHOOL, NAME_RESTORE — bound to the
 *                digest of exactly the list the reviewer saw (listDigest); sets each PENDING change
 *                of the kind APPROVED one by one (an explicit rejection stays); a change whose
 *                dependency is not approved stays PENDING and is reported as blocked
 *   dependencies a change that needs a NEW_PLACE (a new school there, or moving a school's
 *                province / district / sector to it) or its row's CREATE_SCHOOL (the additions of
 *                a new school) cannot be APPROVED until that is; when a NEW_PLACE or CREATE_SCHOOL
 *                becomes PENDING or REJECTED, every APPROVED change depending on it returns to
 *                PENDING (and so on, transitively)
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../sync-compare.js';

export const CATEGORY_KINDS = ['FILL_EMPTY', 'ADD_LEVEL', 'ADD_PROGRAMME', 'CREATE_SCHOOL', 'NAME_RESTORE'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export const SUPER_ADMIN_KINDS = new Set(['RESOLVE_CONFLICT']);
const PLACE_FIELDS = new Set(['province', 'district', 'sector']);
export type Decision = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface ReviewChange {
  id: string; kind: string; field: string | null; itemId: string | null; schoolId: string | null;
  currentValue: unknown; publishedValue: unknown; decision: Decision;
}
export interface ReviewItem {
  id: string; outcome: string;
  normalized: { placeKnown?: boolean; province?: string | null; district?: string | null; sector?: string | null } | null;
}

export const placeKey = (p: { province?: unknown; district?: unknown; sector?: unknown }) =>
  [p.province, p.district, p.sector].map((x) => String(x ?? '').toLowerCase()).join('|');

/** The changes each change depends on (they must be APPROVED first), and the reverse. */
export function dependencyGraph(changes: readonly ReviewChange[], items: readonly ReviewItem[]) {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const placeChange = new Map(changes.filter((c) => c.kind === 'NEW_PLACE').map((c) => [placeKey(c.publishedValue as object), c]));
  const createOf = new Map(changes.filter((c) => c.kind === 'CREATE_SCHOOL' && c.itemId).map((c) => [c.itemId!, c]));
  const deps = new Map<string, ReviewChange[]>();
  const dependents = new Map<string, ReviewChange[]>();
  for (const c of changes) {
    const out: ReviewChange[] = [];
    const item = c.itemId ? itemById.get(c.itemId) : undefined;
    const n = item?.normalized;
    const placeBound = c.kind === 'CREATE_SCHOOL' || ((c.kind === 'CHANGE' || c.kind === 'FILL_EMPTY') && PLACE_FIELDS.has(c.field ?? ''));
    if (n && n.placeKnown === false && placeBound) {
      const p = placeChange.get(placeKey(n));
      if (p) out.push(p);
    }
    if (item?.outcome === 'NEW' && c.kind !== 'CREATE_SCHOOL' && c.kind !== 'NEW_PLACE' && c.kind !== 'RESOLVE_CONFLICT') {
      const create = createOf.get(item.id);
      if (create) out.push(create);
    }
    deps.set(c.id, out);
    for (const d of out) dependents.set(d.id, [...(dependents.get(d.id) ?? []), c]);
  }
  return { deps, dependents };
}

/** The digest of exactly the list a category approval is for (every active change of the kind). */
export function categoryListDigest(changes: readonly ReviewChange[], kind: string): string {
  const list = changes.filter((c) => c.kind === kind).sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => [c.id, c.field, c.schoolId, c.currentValue ?? null, c.publishedValue ?? null, c.decision]);
  return createHash('sha256').update(canonicalJson(list)).digest('hex');
}

/** Every active change's decision (S2b review tokens bind to it). */
export function decisionsDigestOf(changes: ReadonlyArray<{ id: string; decision: string }>): string {
  return createHash('sha256').update(canonicalJson(changes.map((c) => [c.id, c.decision]).sort((a, b) => a[0].localeCompare(b[0])))).digest('hex');
}

export interface DecisionRequest {
  decisions: Array<{ changeId: string; decision: Decision }>;
  categories: Array<{ kind: string; listDigest: string }>;
}

export type DecisionProblem =
  | { code: 'UNKNOWN_CHANGE'; changeId: string }
  | { code: 'SUPER_ADMIN_ONLY'; changeId: string; kind: string }
  | { code: 'NOT_A_CATEGORY_KIND'; kind: string }
  | { code: 'CATEGORY_LIST_CHANGED'; kind: string }
  | { code: 'DEPENDENCY_NOT_APPROVED'; changeId: string; dependsOn: Array<{ changeId: string; kind: string; decision: Decision }> };

export interface DecisionOutcome {
  /** changeId → its new decision (only changes whose decision changes). */
  updates: Map<string, Decision>;
  /** Category changes left PENDING because a dependency is not approved. */
  blocked: string[];
  /** Changes returned to PENDING because a dependency stopped being approved. */
  reverted: string[];
  problems: DecisionProblem[];
}

export function decide(changes: readonly ReviewChange[], items: readonly ReviewItem[], req: DecisionRequest, opts: { superAdmin: boolean }): DecisionOutcome {
  const byId = new Map(changes.map((c) => [c.id, c]));
  const state = new Map(changes.map((c) => [c.id, c.decision]));
  const { deps } = dependencyGraph(changes, items);
  const problems: DecisionProblem[] = [];
  const blocked: string[] = [];
  const unmet = (id: string) => (deps.get(id) ?? []).filter((d) => state.get(d.id) !== 'APPROVED');

  for (const cat of req.categories) {
    if (!(CATEGORY_KINDS as readonly string[]).includes(cat.kind)) problems.push({ code: 'NOT_A_CATEGORY_KIND', kind: cat.kind });
    else if (categoryListDigest(changes, cat.kind) !== cat.listDigest) problems.push({ code: 'CATEGORY_LIST_CHANGED', kind: cat.kind });
  }
  for (const d of req.decisions) {
    const c = byId.get(d.changeId);
    if (!c) problems.push({ code: 'UNKNOWN_CHANGE', changeId: d.changeId });
    else if (SUPER_ADMIN_KINDS.has(c.kind) && !opts.superAdmin) problems.push({ code: 'SUPER_ADMIN_ONLY', changeId: c.id, kind: c.kind });
  }
  if (problems.length) return { updates: new Map(), blocked, reverted: [], problems };

  // Individual decisions — places and new schools first, so a request may approve a place and
  // what depends on it together.
  const order = (k: string) => (k === 'NEW_PLACE' ? 0 : k === 'CREATE_SCHOOL' ? 1 : 2);
  const individual = [...req.decisions].sort((a, b) => order(byId.get(a.changeId)!.kind) - order(byId.get(b.changeId)!.kind));
  for (const d of individual) {
    if (d.decision === 'APPROVED') {
      const missing = unmet(d.changeId);
      if (missing.length) {
        problems.push({ code: 'DEPENDENCY_NOT_APPROVED', changeId: d.changeId, dependsOn: missing.map((m) => ({ changeId: m.id, kind: m.kind, decision: state.get(m.id)! })) });
        continue;
      }
    }
    state.set(d.changeId, d.decision);
  }
  if (problems.length) return { updates: new Map(), blocked, reverted: [], problems };

  // Categories (places and new schools first as well).
  for (const cat of [...req.categories].sort((a, b) => order(a.kind) - order(b.kind))) {
    for (const c of changes.filter((x) => x.kind === cat.kind && state.get(x.id) === 'PENDING')) {
      if (unmet(c.id).length) blocked.push(c.id);
      else state.set(c.id, 'APPROVED');
    }
  }

  // Cascade: whatever depends on something no longer approved returns to PENDING.
  const reverted: string[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, decision] of state) {
      if (decision !== 'APPROVED') continue;
      if (unmet(id).length) { state.set(id, 'PENDING'); reverted.push(id); changed = true; }
    }
  }

  const updates = new Map<string, Decision>();
  for (const [id, decision] of state) if (decision !== byId.get(id)!.decision) updates.set(id, decision);
  return { updates, blocked, reverted, problems };
}

/** APPROVED changes whose dependencies are not all APPROVED (apply refuses them). */
export function unmetDependencies(changes: readonly ReviewChange[], items: readonly ReviewItem[]): string[] {
  const { deps } = dependencyGraph(changes, items);
  const decision = new Map(changes.map((c) => [c.id, c.decision]));
  return changes.filter((c) => c.decision === 'APPROVED' && (deps.get(c.id) ?? []).some((d) => decision.get(d.id) !== 'APPROVED')).map((c) => c.id);
}
