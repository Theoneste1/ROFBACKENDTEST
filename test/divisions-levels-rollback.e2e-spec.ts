/**
 * The rollback of 20261224000000_divisions_levels (docs/migrations/…rollback.sql), run for real on the test database
 * inside a transaction that is then rolled back (its final COMMIT is replaced), so the next specs keep the new schema:
 *  - with only JUNIOR / SENIOR in use it runs to the end: Division.code and Test.division are the former enums again,
 *    the new tables and columns are gone, every student keeps the same division, tests keep their level, and coach
 *    assignments and enrolments are untouched;
 *  - it refuses, changing nothing, while a student is in another division (MIDDLE), while a level was set by hand
 *    (unless acknowledged), and while a saved report or table layout exists (unless acknowledged).
 * Runs on its own freshly reset test database (never production).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { createTestApp, type TestContext } from './helpers.js';

const ROLLBACK = join(__dirname, '..', 'docs', 'migrations', '20261224000000_divisions_levels.rollback.sql');
/** The rollback without its final COMMIT: the caller inspects the result in the same transaction, then rolls back. */
const rollbackBody = () => {
  const sql = readFileSync(ROLLBACK, 'utf8').replace(/\r\n/g, '\n').trimEnd();
  if (!sql.endsWith('COMMIT;')) throw new Error('the rollback does not end with COMMIT;');
  return sql.replace(/COMMIT;$/, '');
};

describe('Rollback of divisions and Olympiad levels (20261224000000)', () => {
  let ctx: TestContext;
  const p = () => ctx.prisma;

  async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const url = new URL(process.env.DATABASE_URL!);
    url.search = '';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  }
  /** Runs the rollback with the given acknowledgements; returns its error, or what the database looks like after it. */
  async function rehearse(settings: string[] = []) {
    return withClient(async (c) => {
      try {
        await c.query(`BEGIN; ${settings.map((s) => `SET LOCAL ${s};`).join(' ')}`);
        // The file opens its own transaction (BEGIN inside one is only a warning) and ends without COMMIT here.
        await c.query(rollbackBody());
        const q = async (sql: string) => (await c.query(sql)).rows;
        const after = {
          codeType: (await q(`SELECT udt_name FROM information_schema.columns WHERE table_name = 'Division' AND column_name = 'code'`))[0].udt_name,
          testType: (await q(`SELECT udt_name FROM information_schema.columns WHERE table_name = 'Test' AND column_name = 'division'`))[0].udt_name,
          divisions: (await q(`SELECT code::text FROM "Division" ORDER BY code`)).map((r) => r.code),
          newTables: (await q(`SELECT table_name FROM information_schema.tables WHERE table_name IN ('DivisionChange','CourseDivision','TableLayout','CustomReport','CustomReportGrant') ORDER BY 1`)).map((r) => r.table_name),
          students: (await q(`SELECT u.id, d.code::text AS code FROM "User" u JOIN "Division" d ON d.id = u."divisionId" WHERE u.role = 'STUDENT' ORDER BY u.id`)),
          tests: (await q(`SELECT id, division::text AS division FROM "Test" ORDER BY id`)),
          assignments: Number((await q(`SELECT count(*) FROM "MentorAssignment"`))[0].count),
          enrolments: Number((await q(`SELECT count(*) FROM "StudentEnrollment"`))[0].count),
        };
        await c.query('ROLLBACK');
        return { after, error: null as string | null };
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        return { after: null, error: (e as Error).message };
      }
    });
  }
  const before = async () => ({
    students: (await p().user.findMany({ where: { role: 'STUDENT' }, select: { id: true, division: { select: { code: true } } }, orderBy: { id: 'asc' } }))
      .map((s) => ({ id: s.id, code: s.division!.code })),
    tests: (await p().test.findMany({ select: { id: true, division: true }, orderBy: { id: 'asc' } })),
    assignments: await p().mentorAssignment.count(),
    enrolments: await p().studentEnrollment.count(),
  });

  beforeAll(async () => {
    ctx = await createTestApp();
    const disciplineId = (await p().course.findUniqueOrThrow({ where: { id: ctx.ids.algebra }, select: { disciplineId: true } })).disciplineId;
    const at = (h: number) => new Date(Date.now() + h * 3_600_000);
    for (const division of ['JUNIOR', 'SENIOR', 'ALL']) {
      await p().test.create({ data: { title: `Rollback ${division}`, disciplineId, division, answerFormat: 'TYPED_ONLY', opensAt: at(-1), closesAt: at(2), originalClosesAt: at(2), maxMarks: 10 } });
    }
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('runs to the end with only Junior and Senior in use: former enums, new objects gone, every record kept', async () => {
    const was = await before();
    expect(was.students.length).toBeGreaterThan(0);
    const { after, error } = await rehearse();
    expect(error).toBeNull();
    expect(after).toEqual({
      codeType: 'DivisionCode', testType: 'TestDivision', divisions: ['JUNIOR', 'SENIOR'], newTables: [],
      students: was.students, tests: was.tests, assignments: was.assignments, enrolments: was.enrolments,
    });
    // Rolled back: the new schema is intact.
    expect(await p().division.count({ where: { code: 'MIDDLE' } })).toBe(1);
    expect(await p().divisionChange.count()).toBeGreaterThanOrEqual(0);
  });

  it('refuses while a student is in a division the previous code cannot represent (Middle)', async () => {
    const middle = await p().division.findUniqueOrThrow({ where: { code: 'MIDDLE' } });
    const s = await p().user.findFirstOrThrow({ where: { role: 'STUDENT', divisionId: ctx.ids.junior } });
    /** Writes the division as the application does when it records the change itself (the grade trigger keeps it). */
    const place = (divisionId: string) => withClient(async (c) => {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('rof.division_change', 'recorded', true)`);
      await c.query(`UPDATE "User" SET "divisionId" = $1 WHERE id = $2`, [divisionId, s.id]);
      await c.query('COMMIT');
    });
    await place(middle.id);
    expect((await p().user.findUniqueOrThrow({ where: { id: s.id } })).divisionId).toBe(middle.id);
    const { error } = await rehearse(["rof.divisions_levels_rollback = 'discard-classifications'"]);
    expect(error).toMatch(/DIVISIONS_LEVELS_ROLLBACK_REFUSED: 0 test\(s\) and 1 record\(s\) use a division other than JUNIOR or SENIOR/);
    await place(ctx.ids.junior);
  });

  it('refuses while a level was set by hand, unless acknowledged', async () => {
    const s = await p().user.findFirstOrThrow({ where: { role: 'STUDENT', divisionId: ctx.ids.junior } });
    await p().user.update({ where: { id: s.id }, data: { divisionManual: true } });
    expect((await rehearse()).error).toMatch(/DIVISIONS_LEVELS_ROLLBACK_REFUSED: 1 division\(s\) set by hand/);
    expect((await rehearse(['rof.divisions_levels_rollback = \'discard-classifications\''])).error).toBeNull();
    await p().user.update({ where: { id: s.id }, data: { divisionManual: false } });
  });

  it('refuses while a saved report or table layout exists, unless acknowledged', async () => {
    await p().customReport.create({ data: { name: 'Kept work', source: 'STUDENTS', columns: ['fullName'], filters: [], sort: [], createdById: ctx.ids.admin } });
    await p().tableLayout.create({ data: { owner: 'ORG', table: 'users.students', columns: [{ key: 'name', visible: true }] } });
    expect((await rehearse()).error).toMatch(/DIVISIONS_LEVELS_ROLLBACK_REFUSED: 2 saved report\(s\) or table layout\(s\) would be lost/);
    expect((await rehearse(['rof.divisions_levels_rollback_reports = \'discard-reports-and-layouts\''])).error).toBeNull();
    // Nothing was removed by the refused or rolled-back runs.
    expect(await p().customReport.count()).toBe(1);
    expect(await p().tableLayout.count()).toBe(1);
  });
});
