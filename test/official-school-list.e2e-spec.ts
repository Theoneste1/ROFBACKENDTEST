/**
 * P1-11 — M8 official school list: the real migration SQL, run against fixtures
 * (the e2e database is reset per file, so it starts without the official rows).
 *
 * Every case runs in a transaction that is rolled back; the rollback file is run
 * statement by statement on its own connection and rolled back as well.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

import { execFileSync } from 'node:child_process';

import { createTestApp, type TestContext } from './helpers.js';

const ROOT = join(__dirname, '..');
const M8_SQL = readFileSync(join(ROOT, 'prisma/migrations/20261121000700_official_school_list/migration.sql'), 'utf8');
const M8_ROLLBACK = readFileSync(join(ROOT, 'docs/migrations/20261121000700_official_school_list.rollback.sql'), 'utf8');
const OFFICIAL = 1974;
class Rollback extends Error {}

describe('Official school list (M8, P1-11)', () => {
  let ctx: TestContext;
  const p = () => ctx.prisma;
  beforeAll(async () => { ctx = await createTestApp(); });
  afterAll(async () => { await ctx?.app.close(); });

  async function inRolledBackTx(fn: (tx: any) => Promise<void>) {
    await expect(p().$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000 }))
      .rejects.toBeInstanceOf(Rollback);
  }
  const student = (tx: any, username: string, schoolId: string) => tx.user.create({ data: {
    username, firstName: username, lastName: 'T', email: `${username}@test.local`, role: 'STUDENT',
    gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId,
  } });

  it('loads every official school once, adopts only unambiguous exact matches, keeps ids and students, and is idempotent', async () => {
    await inRolledBackTx(async (tx) => {
      const lycee   = await tx.school.create({ data: { name: 'Lycée De Kigali', location: 'Kigali' } });     // one official match
      const mwendo  = await tx.school.create({ data: { name: 'Gs Mwendo', location: 'Kigali' } });           // 5 official schools share the name
      const unknown = await tx.school.create({ data: { name: 'Unknown Academy', location: 'Kigali' } });     // no match
      const s1 = await student(tx, 'm8.lycee', lycee.id);
      await student(tx, 'm8.mwendo', mwendo.id);

      await tx.$executeRawUnsafe(M8_SQL);

      expect(await tx.school.count({ where: { code: { not: null } } })).toBe(OFFICIAL);
      const adopted = await tx.school.findUniqueOrThrow({ where: { id: lycee.id } });
      expect(adopted).toMatchObject({ code: '110912', name: 'Lycée De Kigali', district: 'Nyarugenge', ownership: 'PUBLIC', nameKey: 'lycee de kigali' });
      expect((await tx.user.findUniqueOrThrow({ where: { id: s1.id } })).schoolId).toBe(lycee.id);
      for (const s of [mwendo, unknown]) expect((await tx.school.findUniqueOrThrow({ where: { id: s.id } })).code).toBeNull();
      // Shared official names are told apart by district; the code is the identity.
      const mwendos = await tx.school.findMany({ where: { nameKey: 'gs mwendo', code: { not: null } }, select: { name: true } });
      expect(mwendos.length).toBe(5);
      expect(new Set(mwendos.map((m: any) => m.name)).size).toBe(5);
      expect(mwendos.map((m: any) => m.name)).toContain('GS MWENDO — Nyarugenge');
      const audit = await tx.auditLog.findFirstOrThrow({ where: { action: 'OFFICIAL_SCHOOL_LIST_LOADED' } });
      expect(audit.metadata).toEqual({ adopted: 1, inserted: OFFICIAL - 1, uncodedRemaining: 3, officialSchools: OFFICIAL });

      // Idempotent: nothing new, no second audit row.
      const total = await tx.school.count();
      await tx.$executeRawUnsafe(M8_SQL);
      expect(await tx.school.count()).toBe(total);
      expect(await tx.auditLog.count({ where: { action: 'OFFICIAL_SCHOOL_LIST_LOADED' } })).toBe(1);
    });
  });

  it('two uncoded schools with the same normalised name: neither adopts; a name already taken gets the code appended', async () => {
    await inRolledBackTx(async (tx) => {
      const a = await tx.school.create({ data: { name: 'ES BUMBOGO', location: 'Gasabo' } });
      const b = await tx.school.create({ data: { name: 'Es Bumbogo', location: 'Gasabo' } });
      await tx.$executeRawUnsafe(M8_SQL);
      for (const s of [a, b]) expect((await tx.school.findUniqueOrThrow({ where: { id: s.id } })).code).toBeNull();
      expect((await tx.school.findUniqueOrThrow({ where: { code: '120101' } })).name).toBe('ES BUMBOGO (120101)');
    });
  });

  it('the read-only reconciliation report predicts exactly what M8 does, and writes nothing', async () => {
    // Committed fixtures (the report runs in its own read-only connection), removed at the end.
    const lycee = await p().school.create({ data: { name: 'Lycée De Kigali', location: 'Kigali' } });
    const mwendo = await p().school.create({ data: { name: 'Gs Mwendo', location: 'Kigali' } });
    const other = await p().school.create({ data: { name: 'Unknown Academy', location: 'Kigali' } });
    const sts = [await student(p(), 'rep.lycee', lycee.id), await student(p(), 'rep.mwendo', mwendo.id)];
    try {
      const before = await p().school.count();
      const out = execFileSync(process.execPath, [join(ROOT, 'scripts/school-reconciliation.mjs'), '--json', '--details'], {
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL }, encoding: 'utf8',
      });
      const report = JSON.parse(out);
      expect(await p().school.count()).toBe(before);   // read-only
      expect(report.exact).toEqual({ schools: 1, students: 1, enrolments: 0, teacherAssignments: 0 });
      expect(report.ambiguous).toMatchObject({ schools: 1, students: 1 });
      expect(report.unmatched.schools).toBe(2);   // Unknown Academy + the seed's Test School
      const byId = Object.fromEntries(report.details.map((d: any) => [d.id, d]));
      expect(byId[lycee.id]).toMatchObject({ category: 'exact', officialCandidates: ['110912'] });
      expect(byId[mwendo.id].category).toBe('ambiguous');
      expect(byId[mwendo.id].officialCandidates).toHaveLength(5);
      expect(byId[other.id].category).toBe('unmatched');

      // M8 then does exactly that (in a rolled-back transaction).
      await inRolledBackTx(async (tx) => {
        await tx.$executeRawUnsafe(M8_SQL);
        expect((await tx.school.findUniqueOrThrow({ where: { id: lycee.id } })).code).toBe('110912');
        expect((await tx.school.findUniqueOrThrow({ where: { id: mwendo.id } })).code).toBeNull();
        expect((await tx.school.findUniqueOrThrow({ where: { id: other.id } })).code).toBeNull();
        expect((await tx.auditLog.findFirstOrThrow({ where: { action: 'OFFICIAL_SCHOOL_LIST_LOADED' } })).metadata)
          .toMatchObject({ adopted: report.exact.schools, inserted: report.m8WouldInsert });
      });
    } finally {
      await p().user.deleteMany({ where: { id: { in: sts.map((s: any) => s.id) } } });
      await p().school.deleteMany({ where: { id: { in: [lycee.id, mwendo.id, other.id] } } });
    }
  });

  it('every official school has the province given by the first digit of its code', async () => {
    await inRolledBackTx(async (tx) => {
      await tx.$executeRawUnsafe(M8_SQL);
      const rows: Array<{ digit: string; province: string; n: number }> = await tx.$queryRawUnsafe(
        `SELECT substr("code", 1, 1) AS digit, "province", count(*)::int AS n FROM "School" WHERE "code" IS NOT NULL GROUP BY 1, 2 ORDER BY 1`);
      expect(rows.map((r) => [r.digit, r.province])).toEqual([
        ['1', 'Kigali City'], ['2', 'Southern Province'], ['3', 'Western Province'], ['4', 'Northern Province'], ['5', 'Eastern Province'],
      ]);
      expect(rows.reduce((n, r) => n + r.n, 0)).toBe(OFFICIAL);
    });
  });

  it('rollback removes only unreferenced official schools M8 inserted, and clears the codes of adopted schools', async () => {
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "School" ("id","name","location","createdAt") VALUES ('pre-m8', 'Lycée De Kigali', 'Kigali', '2026-01-01')`);
      await c.query(M8_SQL);
      // An official school in use (a student registered with it) must survive the rollback.
      const used = (await c.query(`SELECT "id" FROM "School" WHERE "code" = '310205'`)).rows[0].id;
      await c.query(`INSERT INTO "User" ("id","username","firstName","lastName","email","role","gradeLevel","divisionId","schoolId","updatedAt")
                     VALUES ('m8-user', 'm8.user', 'M', 'U', 'm8.user@test.local', 'STUDENT', 'S2', $1, $2, now())`, [ctx.ids.junior, used]);
      // The file's own BEGIN / COMMIT are left out: the test's transaction wraps it and is rolled back.
      const statements = M8_ROLLBACK.split(/;\s*\n/).map((x) => x.replace(/--.*$/gm, '').trim())
        .filter((x) => x && !/^(BEGIN|COMMIT)$/i.test(x));
      for (const s of statements) await c.query(s);
      const left = (await c.query(`SELECT "id","code" FROM "School" WHERE "id" IN ('pre-m8', $1) OR "code" IS NOT NULL ORDER BY "id"`, [used])).rows;
      expect(left).toEqual(expect.arrayContaining([{ id: 'pre-m8', code: null }, { id: used, code: '310205' }]));
      expect(left).toHaveLength(2);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await p().school.count({ where: { code: { not: null } } })).toBe(0);   // nothing persisted
  });
});
