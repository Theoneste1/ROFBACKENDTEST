/**
 * The configurable tables and their columns (owner 2026-11-22: administrators choose, order and hide the columns of
 * the user tables; the username is not shown by default — the full name identifies a user). The keys are the contract
 * with the frontend, which renders each one. A layout may only name these keys, each once.
 */
export interface ColumnDef { key: string; label: string; defaultVisible: boolean }
export interface ColumnSetting { key: string; visible: boolean }

const col = (key: string, label: string, defaultVisible: boolean): ColumnDef => ({ key, label, defaultVisible });

const COMMON_END = [
  col('accountStatus', 'Account status', true), col('registeredAt', 'Registration date', true), col('lastLoginAt', 'Last login', true),
  col('username', 'Username', false), col('country', 'Country', false),
];

export const TABLES: Readonly<Record<string, readonly ColumnDef[]>> = {
  'users.all': [col('name', 'Full name', true), col('email', 'Email', true), col('role', 'Role', true), col('school', 'School', true), ...COMMON_END],
  'users.students': [
    col('name', 'Full name', true), col('email', 'Email', true), col('school', 'School', true), col('grade', 'Grade', true),
    col('olympiadLevel', 'Olympiad level', true), col('subjects', 'Olympiad subjects', false), ...COMMON_END,
  ],
  'users.coaches': [col('name', 'Full name', true), col('email', 'Email', true), col('subjects', 'Olympiad subjects', true), ...COMMON_END],
  'users.headCoaches': [col('name', 'Full name', true), col('email', 'Email', true), col('subjects', 'Olympiad subjects', true), ...COMMON_END],
  'users.teachers': [
    col('name', 'Full name', true), col('email', 'Email', true), col('school', 'School', true), col('testSubmission', 'Test submission', true), ...COMMON_END,
  ],
  'users.admins': [col('name', 'Full name', true), col('email', 'Email', true), col('role', 'Role', true), ...COMMON_END],
};

export const TABLE_KEYS = Object.keys(TABLES);

/** The built-in layout of a table: every column, in order, visible when it is by default. */
export function builtInLayout(table: string): ColumnSetting[] {
  return TABLES[table].map((c) => ({ key: c.key, visible: c.defaultVisible }));
}

/** Problems of a proposed layout (empty: valid): only the table's keys, each once, at least one visible. */
export function layoutProblems(table: string, columns: readonly ColumnSetting[]): string[] {
  const known = new Set(TABLES[table].map((c) => c.key));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of columns) {
    if (!known.has(c.key)) out.push(`unknown column ${c.key}`);
    if (seen.has(c.key)) out.push(`column ${c.key} appears twice`);
    seen.add(c.key);
  }
  if (!columns.some((c) => c.visible)) out.push('at least one column must be visible');
  return out;
}

/**
 * A stored layout made complete for today's table: its columns in their saved order (unknown keys dropped), then any
 * column added to the table since, at its default visibility — so a new column never disappears silently.
 */
export function completeLayout(table: string, stored: readonly ColumnSetting[]): ColumnSetting[] {
  const known = new Map(TABLES[table].map((c) => [c.key, c]));
  const kept = stored.filter((c, i) => known.has(c.key) && stored.findIndex((x) => x.key === c.key) === i);
  const missing = TABLES[table].filter((c) => !kept.some((k) => k.key === c.key)).map((c) => ({ key: c.key, visible: c.defaultVisible }));
  return [...kept.map((c) => ({ key: c.key, visible: !!c.visible })), ...missing];
}
