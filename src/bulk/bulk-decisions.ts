/**
 * Pure helpers shared by the record types added on 2026-11-20 (SCHOOL, SCHOOL_AFFILIATION, TEACHER_APPLICATION,
 * COACH_APPLICATION; docs/operations/bulk-operations.md). They hold no engine behaviour: each handler still decides
 * which records a selection means and calls its single-record service for the change.
 */
import type { EngineSelection, ItemResult } from './bulk-handler.js';

/** At most this many records chosen one by one (the generic route's limit). */
export const DECISION_MAX_IDS = 1000;
/** A filter may match at most this many records of these types in one operation. */
export const DECISION_MAX_SELECTION = 10_000;

const sortKeys = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null).sort(([a], [b]) => a.localeCompare(b)));

/** The canonical selection: ids deduplicated and sorted; filter keys sorted, empty values dropped, strings trimmed. */
export function normaliseFilterSelection(s: EngineSelection): EngineSelection {
  if (s.mode === 'ids') return { mode: 'ids', ids: [...new Set(s.ids)].sort() };
  const trimmed = Object.fromEntries(Object.entries(s.filter ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  return { mode: 'filter', filter: sortKeys(trimmed) };
}

/**
 * A decision on a record with a status (an application, a claim): SKIPPED when it already has the target status
 * (ALREADY_IN_STATE) or is in another status the action does not apply to (`otherCode`, e.g. ALREADY_DECIDED);
 * null when the action applies (`from`).
 */
export function decisionSkip(current: string, target: string, from: readonly string[], otherCode = 'NOT_APPLICABLE'): ItemResult | null {
  if (current === target) return { outcome: 'SKIPPED', code: 'ALREADY_IN_STATE', message: `Already ${target.toLowerCase()}.` };
  if (!from.includes(current)) {
    return { outcome: 'SKIPPED', code: otherCode, message: `This action applies only to ${from.join(' or ').toLowerCase()} records (this one is ${current.toLowerCase()}).` };
  }
  return null;
}

/** Loads rows for many ids, 5 000 at a time (preview warnings read every selected record). */
export async function inChunks<T>(ids: readonly string[], load: (chunk: string[]) => Promise<T[]>, size = 5000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await load(ids.slice(i, i + size))));
  return out;
}

/** For actions without parameters: any `params` key is refused (400 VALIDATION_FAILED); the reason is the operation's. */
export class NoBulkParamsDto {}
