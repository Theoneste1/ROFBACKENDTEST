import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isISO31661Alpha2 } from 'class-validator';

import { COUNTRIES } from './countries.data.js';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '20261211000000_countries_reference', 'migration.sql'), 'utf8',
).replace(/\r\n/g, '\n');

describe('countries reference data (owner decision 2026-11-19)', () => {
  it('every ISO 3166-1 alpha-2 code the API validates, once, sorted — the same rows as the migration inserts', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(codes).toHaveLength(249);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
    for (const c of codes) expect([c, isISO31661Alpha2(c)]).toEqual([c, true]);
    const rows = [...MIGRATION.matchAll(/^ {2}\('([A-Z]{2})', '((?:[^']|'')*)', (NULL|'[^']*'), CURRENT_TIMESTAMP\)[,;]$/gm)]
      .map((m) => ({ code: m[1], name: m[2].replace(/''/g, "'"), phonePrefix: m[3] === 'NULL' ? null : m[3].slice(1, -1) }));
    expect(rows).toEqual([...COUNTRIES]);
  });

  it('no active / inactive switch: the table identifies countries only; Rwanda has its name and calling code', () => {
    expect(MIGRATION).not.toMatch(/isActive/);
    expect(COUNTRIES.find((c) => c.code === 'RW')).toEqual({ code: 'RW', name: 'Rwanda', phonePrefix: '+250' });
  });
});
