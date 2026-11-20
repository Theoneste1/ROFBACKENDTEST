// The database catalogue as a set of labels, and the labels of a migration's object list (scripts/release/releases.mjs,
// MIGRATION_OBJECTS). Shared by the rehearsal runner (rollback state detection) and its tests. Read only.

/**
 * Every object of schema public, one label each (read only):
 *   table T · column T.c · enum E · enum value E.v · index T.I (not backing a constraint) · constraint T.C (primary key,
 *   foreign key, unique, check, exclusion) · trigger T.t · function f.
 * @param {import('pg').Client} client
 * @returns {Promise<Set<string>>}
 */
export async function catalogLabels(client) {
  const { rows } = await client.query(`
    SELECT 'table ' || c.relname AS l FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
    UNION ALL
    SELECT 'column ' || c.relname || '.' || a.attname FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'enum ' || t.typname FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype = 'e'
    UNION ALL
    SELECT 'enum value ' || t.typname || '.' || e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
     WHERE t.typnamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'index ' || c.relname || '.' || i.relname FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class c ON c.oid = x.indrelid
     WHERE i.relnamespace = 'public'::regnamespace
       AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.oid AND k.contype IN ('p', 'u', 'x'))
    UNION ALL
    SELECT 'constraint ' || c.relname || '.' || k.conname FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
     WHERE c.relnamespace = 'public'::regnamespace AND k.contype IN ('p', 'f', 'u', 'c', 'x')
    UNION ALL
    SELECT 'trigger ' || c.relname || '.' || t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
    UNION ALL
    SELECT 'function ' || p.proname FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace`);
  return new Set(rows.map((r) => r.l));
}

/** The migrations recorded in _prisma_migrations, as labels "history <name>" (none when the table does not exist). */
export async function historyLabels(client, names) {
  const has = (await client.query(`SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS ok`)).rows[0].ok;
  if (!has) return new Set();
  const { rows } = await client.query('SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ANY($1)', [names]);
  return new Set(rows.map((r) => `history ${r.migration_name}`));
}

/**
 * The markers of one migration's object list: [label, whenApplied] pairs. whenApplied = true: the object exists while the
 * migration is applied (it creates it); false: it exists only once the migration is rolled back (the migration drops it
 * and its rollback restores it, e.g. an index replaced by the migration).
 */
export function markers(name, o) {
  const created = o.creates ?? {};
  const dropped = o.drops ?? {};
  const labels = (x) => [
    ...(x.tables ?? []).map((t) => `table ${t}`),
    ...(x.columns ?? []).map(([t, c]) => `column ${t}.${c}`),
    ...(x.enums ?? []).map((e) => `enum ${e}`),
    ...(x.enumValues ?? []).map(([e, v]) => `enum value ${e}.${v}`),
    ...(x.indexes ?? []).map(([t, i]) => `index ${t}.${i}`),
    ...(x.constraints ?? []).map(([t, c]) => `constraint ${t}.${c}`),
    ...(x.triggers ?? []).map(([t, g]) => `trigger ${t}.${g}`),
    ...(x.functions ?? []).map((f) => `function ${f}`),
  ];
  return [...labels(created).map((l) => [l, true]), ...labels(dropped).map((l) => [l, false]), ...(o.history ? [[`history ${name}`, true]] : [])];
}

const KINDS = [['table', 'tables'], ['column', 'columns'], ['enum value', 'enumValues'], ['enum', 'enums'], ['index', 'indexes'],
  ['constraint', 'constraints'], ['trigger', 'triggers'], ['function', 'functions']];

/**
 * The object list of one migration from the catalogue before and after it (labels from catalogLabels): what it creates and
 * what it drops. Objects that belong to a table the migration creates (its columns, indexes, constraints, triggers) and the
 * values of an enum it creates are left out — they go with the table or the enum.
 */
export function objectsFromCatalog(before, after) {
  const build = (labels) => {
    const out = {};
    for (const label of [...labels].sort()) {
      const [kind, key] = KINDS.find(([k]) => label.startsWith(`${k} `));
      const rest = label.slice(kind.length + 1);
      (out[key] ??= []).push(['tables', 'enums', 'functions'].includes(key) ? rest : [rest.slice(0, rest.indexOf('.')), rest.slice(rest.indexOf('.') + 1)]);
    }
    return out;
  };
  const prune = (o) => {
    const tables = new Set(o.tables ?? []);
    const enums = new Set(o.enums ?? []);
    for (const key of ['columns', 'indexes', 'constraints', 'triggers']) if (o[key]) o[key] = o[key].filter(([t]) => !tables.has(t));
    if (o.enumValues) o.enumValues = o.enumValues.filter(([e]) => !enums.has(e));
    for (const k of Object.keys(o)) if (!o[k].length) delete o[k];
    return o;
  };
  return {
    creates: prune(build([...after].filter((l) => !before.has(l)))),
    drops: prune(build([...before].filter((l) => !after.has(l)))),
  };
}
