/**
 * Infers OpenAPI 3.0 schemas from real JSON responses and merges the schemas
 * of many responses into one. Used to document what every endpoint returns,
 * from what the end-to-end tests actually received (see record-responses.ts).
 */
export interface Schema {
  type?:       'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  format?:     'uuid' | 'date-time';
  nullable?:   boolean;
  properties?: Record<string, Schema>;
  required?:   string[];
  items?:      Schema;
  anyOf?:      Schema[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MAX_DEPTH = 10;
const MAX_ITEMS = 50;

/** The schema of one value. `null` alone has no type yet: it only marks the property nullable. */
export function inferSchema(value: unknown, depth = 0): Schema {
  if (value === null || value === undefined) return { nullable: true };
  if (depth > MAX_DEPTH) return {};
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((v) => inferSchema(v, depth + 1));
    return { type: 'array', ...(items.length && { items: items.reduce(mergeSchemas) }) };
  }
  switch (typeof value) {
    case 'string':
      return { type: 'string', ...(UUID.test(value) ? { format: 'uuid' } : ISO_DATE_TIME.test(value) ? { format: 'date-time' } : {}) };
    case 'number':  return { type: Number.isInteger(value) ? 'integer' : 'number' };
    case 'boolean': return { type: 'boolean' };
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>);
      return {
        type: 'object',
        properties: Object.fromEntries(entries.map(([k, v]) => [k, inferSchema(v, depth + 1)])),
        required: entries.map(([k]) => k),
      };
    }
    default: return {};
  }
}

/** A schema that accepts everything both schemas accept. */
export function mergeSchemas(a: Schema | undefined, b: Schema | undefined): Schema {
  if (!a) return b ?? {};
  if (!b) return a;
  const nullable = a.nullable || b.nullable ? { nullable: true as const } : {};
  // A typeless schema is "null so far": take the other one's shape.
  if (!a.type && !a.anyOf) return { ...b, ...nullable };
  if (!b.type && !b.anyOf) return { ...a, ...nullable };

  const numeric = (t?: string) => t === 'integer' || t === 'number';
  if (a.type === b.type || (numeric(a.type) && numeric(b.type))) {
    const type = a.type === b.type ? a.type : 'number';
    const format = a.format && a.format === b.format ? { format: a.format } : {};
    if (type === 'object') {
      const keys = [...new Set([...Object.keys(a.properties ?? {}), ...Object.keys(b.properties ?? {})])];
      const required = (a.required ?? []).filter((k) => (b.required ?? []).includes(k));
      return {
        type, ...nullable,
        properties: Object.fromEntries(keys.map((k) => [k, mergeSchemas(a.properties?.[k], b.properties?.[k])])),
        ...(required.length && { required }),
      };
    }
    if (type === 'array') {
      const items = a.items && b.items ? mergeSchemas(a.items, b.items) : a.items ?? b.items;
      return { type, ...nullable, ...(items && { items }) };
    }
    return { type, ...format, ...nullable };
  }
  // Genuinely different types (rare): keep both.
  const variants = [...(a.anyOf ?? [stripNullable(a)]), ...(b.anyOf ?? [stripNullable(b)])];
  const unique = variants.filter((v, i) => variants.findIndex((w) => JSON.stringify(w) === JSON.stringify(v)) === i);
  return { anyOf: unique, ...nullable };
}

function stripNullable(s: Schema): Schema {
  const { nullable: _n, ...rest } = s;
  return rest;
}

/** Stable key order, so regenerated files only change when the API does. */
export function sortSchema(s: Schema): Schema {
  const out: Schema = {};
  for (const key of Object.keys(s).sort() as Array<keyof Schema>) {
    const v = s[key];
    if (key === 'properties' && v) {
      out.properties = Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortSchema((v as Record<string, Schema>)[k])]));
    } else if (key === 'items' && v) {
      out.items = sortSchema(v as Schema);
    } else if (key === 'anyOf' && v) {
      out.anyOf = (v as Schema[]).map(sortSchema);
    } else if (key === 'required' && v) {
      out.required = [...(v as string[])].sort();
    } else {
      (out as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}
