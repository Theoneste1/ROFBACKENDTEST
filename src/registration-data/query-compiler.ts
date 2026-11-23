/**
 * Registration data: filters, sorting, selection and values — compiled from the catalogue (field-catalogue.service.ts)
 * into Prisma queries. Pure functions, no database.
 *
 * Safety: a filter names fields by catalogue key and conditions by name; both are checked against the catalogue and the
 * operator list of the field's type, values are parsed into the column's type, and everything becomes a Prisma `where`
 * (bound parameters) — no text from a request ever reaches SQL. Unknown or ineligible fields are refused, not ignored.
 */
import type { Prisma } from '../generated/prisma/client.js';
import { SOURCES } from './field-policy.js';
import type { Field, FieldType } from './field-catalogue.service.js';

export const OPERATORS: Readonly<Record<FieldType, readonly string[]>> = {
  text: ['contains', 'notContains', 'eq', 'neq', 'startsWith', 'isEmpty', 'isNotEmpty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isEmpty', 'isNotEmpty'],
  date: ['on', 'before', 'after', 'between', 'isEmpty', 'isNotEmpty'],
  datetime: ['on', 'before', 'after', 'between', 'isEmpty', 'isNotEmpty'],
  boolean: ['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty'],
  enum: ['in', 'notIn', 'isEmpty', 'isNotEmpty'],
  enumList: ['hasAny', 'hasAll', 'hasNone', 'isEmpty', 'isNotEmpty'],
  textList: ['hasAny', 'hasAll', 'hasNone', 'isEmpty', 'isNotEmpty'],
};

/** In words, for the filter builder. */
export const OPERATOR_LABELS: Readonly<Record<string, string>> = {
  contains: 'contains', notContains: 'does not contain', eq: 'is', neq: 'is not', startsWith: 'starts with',
  gt: 'is greater than', gte: 'is at least', lt: 'is less than', lte: 'is at most', between: 'is between',
  on: 'is on', before: 'is before', after: 'is after',
  isTrue: 'is yes', isFalse: 'is no', in: 'is any of', notIn: 'is none of',
  hasAny: 'includes any of', hasAll: 'includes all of', hasNone: 'includes none of',
  isEmpty: 'is empty', isNotEmpty: 'is not empty',
};

export const MAX_CONDITIONS = 50;
export const MAX_DEPTH = 4;

export interface FilterCondition { field: string; operator: string; value?: unknown; value2?: unknown }
export interface FilterGroup { combinator: 'AND' | 'OR'; conditions: Array<FilterCondition | FilterGroup> }
export interface SortSpec { field: string; dir: 'asc' | 'desc' }

export class QueryProblem extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('; '));
  }
}

const isGroup = (c: FilterCondition | FilterGroup): c is FilterGroup => !!c && typeof c === 'object' && 'conditions' in c;
const ins = { mode: 'insensitive' as const };

/** Kigali has no daylight saving time: UTC+2 all year. A date typed by a person is a day in Kigali. */
const KIGALI_OFFSET_MS = 2 * 3_600_000;

function parseDay(v: unknown): Date | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
}

/** A day's bounds for the field: a date column compares dates; a date-time column the Kigali day. */
function dayBounds(f: Field, v: unknown): { start: Date; end: Date } | null {
  const d = parseDay(v);
  if (!d) return null;
  const start = f.type === 'datetime' ? new Date(d.getTime() - KIGALI_OFFSET_MS) : d;
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

function parseNumber(f: Field, v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return f.integer && !Number.isInteger(n) ? null : n;
}

function parseList(f: Field, v: unknown): string[] | null {
  const list = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string').map((x) => (x as string).trim()).filter(Boolean);
  if (!list.length || list.length > 100) return null;
  if (f.values && list.some((x) => !f.values!.includes(x))) return null;
  return list;
}

function parseText(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  return s && s.length <= 200 ? s : null;
}

/** The condition on the column itself (positive form), or null when the value does not fit. */
function columnCondition(f: Field, operator: string, value: unknown, value2: unknown): Record<string, unknown> | null {
  switch (f.type) {
    case 'text': {
      const s = parseText(value);
      if (!s) return null;
      if (operator === 'contains' || operator === 'notContains') return { contains: s, ...ins };
      if (operator === 'eq' || operator === 'neq') return { equals: s, ...ins };
      if (operator === 'startsWith') return { startsWith: s, ...ins };
      return null;
    }
    case 'number': {
      const a = parseNumber(f, value);
      if (a === null) return null;
      if (operator === 'eq' || operator === 'neq') return { equals: a };
      if (['gt', 'gte', 'lt', 'lte'].includes(operator)) return { [operator]: a };
      if (operator === 'between') {
        const b = parseNumber(f, value2);
        return b === null ? null : { gte: Math.min(a, b), lte: Math.max(a, b) };
      }
      return null;
    }
    case 'date':
    case 'datetime': {
      const a = dayBounds(f, value);
      if (!a) return null;
      if (operator === 'on') return { gte: a.start, lt: a.end };
      if (operator === 'before') return { lt: a.start };
      if (operator === 'after') return { gte: a.end };
      if (operator === 'between') {
        const b = dayBounds(f, value2);
        if (!b) return null;
        const [lo, hi] = a.start <= b.start ? [a, b] : [b, a];
        return { gte: lo.start, lt: hi.end };   // both days included
      }
      return null;
    }
    case 'boolean':
      return operator === 'isTrue' ? { equals: true } : operator === 'isFalse' ? { equals: false } : null;
    case 'enum': {
      const list = parseList(f, value);
      return list && (operator === 'in' || operator === 'notIn') ? { in: list } : null;
    }
    case 'enumList':
    case 'textList': {
      const list = parseList(f, value);
      if (!list) return null;
      if (operator === 'hasAny' || operator === 'hasNone') return { hasSome: list };
      if (operator === 'hasAll') return { hasEvery: list };
      return null;
    }
  }
}

const NEGATED: Record<string, string> = { notContains: 'contains', neq: 'eq', notIn: 'in', hasNone: 'hasAny' };

/** The column a field filters and sorts on: a reference filters on the related record's name. */
function target(f: Field): { relation: string; column: string; through: 'self' | 'one' | 'many' } {
  if (f.reference === 'school') return { relation: 'school', column: 'name', through: 'one' };
  if (f.reference === 'division') return { relation: 'division', column: 'name', through: 'one' };
  const rel = SOURCES[f.source].relation;
  return { relation: rel, column: f.column, through: rel === '' ? 'self' : rel === 'schoolAffiliations' ? 'many' : 'one' };
}

/** A where clause on a user row for a condition on the field's column. */
function onRow(f: Field, cond: Record<string, unknown>): Prisma.UserWhereInput {
  const t = target(f);
  const inner = { [t.column]: cond };
  if (t.through === 'self') return inner as Prisma.UserWhereInput;
  if (t.through === 'one') return { [t.relation]: { is: inner } } as Prisma.UserWhereInput;
  // The current school claim: the one not superseded.
  return { [t.relation]: { some: { supersededAt: null, ...inner } } } as Prisma.UserWhereInput;
}

/** "Empty": no related record, no value, an empty text or an empty list. */
function emptyWhere(f: Field): Prisma.UserWhereInput {
  const t = target(f);
  const list = f.type === 'enumList' || f.type === 'textList';
  const emptyCol: Array<Record<string, unknown>> = list ? [{ [t.column]: { isEmpty: true } }]
    : f.type === 'text' ? [{ [t.column]: null }, { [t.column]: '' }] : f.nullable || t.through !== 'self' ? [{ [t.column]: null }] : [];
  if (t.through === 'self') return emptyCol.length ? { OR: emptyCol } as Prisma.UserWhereInput : { id: { in: [] } };
  if (t.through === 'one') return { OR: [{ [t.relation]: { is: null } }, ...emptyCol.map((c) => ({ [t.relation]: { is: c } }))] } as Prisma.UserWhereInput;
  const notEmpty = list ? { NOT: { [t.column]: { isEmpty: true } } } : f.type === 'text' ? { AND: [{ [t.column]: { not: null } }, { NOT: { [t.column]: '' } }] } : { [t.column]: { not: null } };
  return { NOT: { [t.relation]: { some: { supersededAt: null, ...notEmpty } } } } as Prisma.UserWhereInput;
}

function conditionWhere(c: FilterCondition, byKey: Map<string, Field>, problems: string[]): Prisma.UserWhereInput | null {
  const f = byKey.get(c.field);
  if (!f) {
    problems.push(`The field "${c.field}" is not available here.`);
    return null;
  }
  if (!f.filterable || !OPERATORS[f.type].includes(c.operator)) {
    problems.push(`"${f.label}" cannot be filtered with "${OPERATOR_LABELS[c.operator] ?? c.operator}".`);
    return null;
  }
  if (c.operator === 'isEmpty') return emptyWhere(f);
  if (c.operator === 'isNotEmpty') return { NOT: emptyWhere(f) };
  const cond = columnCondition(f, c.operator, c.value, c.value2);
  if (!cond) {
    problems.push(`"${f.label}" ${OPERATOR_LABELS[c.operator]}: the value is missing or not valid for this field.`);
    return null;
  }
  const where = onRow(f, cond);
  if (!NEGATED[c.operator]) return where;
  // "Is not" / "does not contain" / "none of" also match records with no value (an empty field never contains "x").
  // Said explicitly: in SQL, NOT (NULL ILIKE …) is not true, so a NOT alone would drop the empty ones.
  const t = target(f);
  const missing: Prisma.UserWhereInput[] = t.through === 'self' ? (f.nullable ? [{ [t.column]: null } as Prisma.UserWhereInput] : [])
    : t.through === 'one' ? [{ [t.relation]: { is: null } }, { [t.relation]: { is: { [t.column]: null } } }] as Prisma.UserWhereInput[]
    : [];
  return missing.length ? { OR: [...missing, { NOT: where }] } : { NOT: where };
}

/** The where clause of a filter tree. Throws QueryProblem listing every problem, in plain words. */
export function compileFilter(group: FilterGroup | null | undefined, fields: readonly Field[]): Prisma.UserWhereInput {
  if (!group) return {};
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const problems: string[] = [];
  let count = 0;
  const walk = (g: FilterGroup, depth: number): Prisma.UserWhereInput => {
    if (depth > MAX_DEPTH) {
      problems.push(`Filters can be nested at most ${MAX_DEPTH} levels deep.`);
      return {};
    }
    if (!g || !Array.isArray(g.conditions) || (g.combinator !== 'AND' && g.combinator !== 'OR')) {
      problems.push('A filter group must say whether all (AND) or any (OR) of its conditions must match.');
      return {};
    }
    const parts: Prisma.UserWhereInput[] = [];
    for (const c of g.conditions) {
      if (isGroup(c)) {
        const w = walk(c, depth + 1);
        if (Object.keys(w).length) parts.push(w);
        continue;
      }
      count += 1;
      const w = conditionWhere(c, byKey, problems);
      if (w) parts.push(w);
    }
    if (!parts.length) return {};
    return g.combinator === 'AND' ? { AND: parts } : { OR: parts };
  };
  const where = walk(group, 1);
  if (count > MAX_CONDITIONS) problems.push(`A filter can have at most ${MAX_CONDITIONS} conditions.`);
  if (problems.length) throw new QueryProblem(problems);
  return where;
}

/** The order: the chosen fields (at most 3), then by name, then by id (a total order: stable pages). */
export function compileSort(sort: readonly SortSpec[] | undefined, fields: readonly Field[]): Prisma.UserOrderByWithRelationInput[] {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const problems: string[] = [];
  const out: Prisma.UserOrderByWithRelationInput[] = [];
  for (const s of (sort ?? []).slice(0, 3)) {
    const f = byKey.get(s.field);
    if (!f || !f.sortable) {
      problems.push(`The table cannot be sorted by "${f?.label ?? s.field}".`);
      continue;
    }
    const dir = s.dir === 'desc' ? 'desc' : 'asc';
    if (f.reference === 'division') {
      out.push({ division: { sortOrder: dir } });
      continue;
    }
    const t = target(f);
    const nullable = f.nullable || t.through !== 'self';
    const by = nullable ? { sort: dir, nulls: 'last' as const } : dir;
    out.push((t.through === 'self' ? { [t.column]: by } : { [t.relation]: { [t.column]: by } }) as Prisma.UserOrderByWithRelationInput);
  }
  if (problems.length) throw new QueryProblem(problems);
  return [...out, ...(out.length ? [] : [{ lastName: 'asc' as const }, { firstName: 'asc' as const }]), { id: 'asc' }];
}

/** The quick search box: names, e-mail and username. */
export function searchWhere(search: string | undefined): Prisma.UserWhereInput {
  const s = search?.trim();
  if (!s) return {};
  const words = s.split(/\s+/).slice(0, 5);
  return {
    AND: words.map((w) => ({ OR: [
      { firstName: { contains: w, ...ins } }, { lastName: { contains: w, ...ins } },
      { email: { contains: w, ...ins } }, { username: { contains: w, ...ins } },
    ] })),
  };
}

/** What to read for the chosen fields (always the id, role and last change). */
export function compileSelect(chosen: readonly Field[]): Prisma.UserSelect {
  const select: Record<string, unknown> = { id: true, role: true, updatedAt: true };
  const rel: Record<string, Record<string, true>> = {};
  for (const f of chosen) {
    if (f.reference) {
      select[f.column] = true;
      (rel[f.reference] ??= {}).name = true;
      continue;
    }
    const r = SOURCES[f.source].relation;
    if (r === '') select[f.column] = true;
    else (rel[r] ??= {})[f.column] = true;
  }
  for (const [r, cols] of Object.entries(rel)) {
    select[r] = r === 'schoolAffiliations'
      ? { where: { supersededAt: null }, orderBy: { createdAt: 'desc' }, take: 1, select: cols }
      : { select: cols };
  }
  return select as Prisma.UserSelect;
}

export type CellValue = string | number | boolean | string[] | null;

/** A field's value on a row read with compileSelect (dates as YYYY-MM-DD or ISO time; references by name). */
export function valueOf(f: Field, row: Record<string, unknown>): CellValue {
  let v: unknown;
  if (f.reference) v = (row[f.reference] as { name?: string } | null)?.name ?? null;
  else {
    const r = SOURCES[f.source].relation;
    const holder = r === '' ? row : r === 'schoolAffiliations' ? (row[r] as unknown[] | undefined)?.[0] : row[r];
    v = holder && typeof holder === 'object' ? (holder as Record<string, unknown>)[f.column] : null;
  }
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return f.type === 'date' ? v.toISOString().slice(0, 10) : v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object' && 'toNumber' in (v as object)) return (v as { toNumber(): number }).toNumber();
  return v as CellValue;
}

/** A value as text for an export cell (lists joined, yes / no, choices in words). */
export function exportText(f: Field, v: CellValue): string | number | null {
  if (v === null) return null;
  if (Array.isArray(v)) return v.map((x) => f.valueLabels?.[x] ?? x).join(', ') || null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string' && f.valueLabels) return f.valueLabels[v] ?? v;
  return v;
}
