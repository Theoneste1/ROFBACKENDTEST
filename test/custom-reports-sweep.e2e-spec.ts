/**
 * Custom reports, every combination (owner report 2026-11-25: "Couldn't load this" while making a report):
 * every source × every sortable column (both directions) × every filter of every filterable column with typical and
 * odd values, plus a saved report's run, exports and grants. None may end in a server error.
 *
 * The cause found: sorting with "empty last" and testing for empty on columns that are never empty (names, username,
 * e-mail, role, account status, registration date) — the database refuses both. The results must also stay right.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';
import { FILTER_OPS, SOURCES } from '../src/custom-reports/report-sources.js';

const sample = (type: string, values?: readonly string[]): unknown[] =>
  type === 'date' ? ['2026-01-01', '', 'not-a-date', null]
  : type === 'boolean' ? [true, false, 'true', null]
  : type === 'enum' || type === 'list' ? [values?.[0], [values?.[0]], [], 'x', null]
  : ['a', '', ['a', 'b'], 5, null];

describe('Custom reports: no combination ends in a server error (e2e)', () => {
  let ctx: TestContext;
  let admin: string;
  beforeAll(async () => { ctx = await createTestApp(); admin = await login(ctx, 'admin'); });
  afterAll(async () => { await ctx?.app.close(); });

  const preview = (body: object) => ctx.http().post('/api/v1/reports/preview').set(bearer(admin)).send(body);

  it('every source, sort and filter answers without a server error', async () => {
    const fails: string[] = [];
    const check = async (label: string, body: object) => {
      const r = await preview(body);
      if (r.status >= 500) fails.push(`${label}: ${r.status}`);
    };
    // As an Administrator: the Super-Admin-only source and protected fields are refused to them (covered as the Super
    // Admin in custom-reports-data.e2e-spec.ts).
    for (const src of Object.values(SOURCES).filter((x) => !x.superAdminOnly).map((x) => ({ ...x, fields: x.fields.filter((f) => !f.protected) }))) {
      const columns = src.fields.map((f) => f.key);
      await check(`${src.key} all columns`, { source: src.key, columns });
      for (const f of src.fields) {
        if (f.orderBy) for (const dir of ['asc', 'desc']) await check(`${src.key} sort ${f.key} ${dir}`, { source: src.key, columns, sort: [{ field: f.key, dir }] });
        if (f.where) for (const op of FILTER_OPS) for (const value of sample(f.type, f.values)) {
          await check(`${src.key} ${f.key} ${op} ${JSON.stringify(value)}`, { source: src.key, columns, filters: [{ field: f.key, op, value }] });
        }
      }
    }
    expect(fails).toEqual([]);
  }, 300_000);  // about 1,000 requests

  it('the results stay right: sorted by last name; "is empty" on a never-empty column matches nothing, "is not empty" everything', async () => {
    const cols = ['lastName', 'username'];
    const asc = await preview({ source: 'USERS', columns: cols, sort: [{ field: 'lastName', dir: 'asc' }, { field: 'username', dir: 'asc' }] });
    expect(asc.status).toBeLessThan(300);
    const names = (asc.body.rows as unknown[][]).map((r) => String(r[0]));
    expect(names).toEqual([...names].sort());

    const all = await preview({ source: 'USERS', columns: cols });
    const empty = await preview({ source: 'USERS', columns: cols, filters: [{ field: 'username', op: 'isEmpty' }] });
    const notEmpty = await preview({ source: 'USERS', columns: cols, filters: [{ field: 'role', op: 'isNotEmpty' }] });
    expect(all.body.meta.total).toBeGreaterThan(0);
    expect(empty.body.meta.total).toBe(0);
    expect(notEmpty.body.meta.total).toBe(all.body.meta.total);
  });

  it('a saved report: run, CSV and Excel exports, grants', async () => {
    const created = await ctx.http().post('/api/v1/reports').set(bearer(admin))
      .send({ name: 'Every student', source: 'STUDENTS', columns: SOURCES.STUDENTS.fields.filter((f) => !f.protected).map((f) => f.key), sort: [{ field: 'lastName', dir: 'asc' }] });
    expect(created.status).toBe(201);
    for (const url of ['', '/run', '/export?format=csv', '/export?format=xlsx', '/grants']) {
      const r = await ctx.http().get(`/api/v1/reports/${created.body.id}${url}`).set(bearer(admin));
      expect([url, r.status]).toEqual([url, 200]);
    }
  });
});
