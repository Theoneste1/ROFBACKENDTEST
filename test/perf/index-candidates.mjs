#!/usr/bin/env node
/**
 * Index candidates (NOT part of CI, NOT a migration): on a DISPOSABLE copy of a scale database,
 * times representative queries (EXPLAIN ANALYZE, warm cache: best of 3) before and after a plain
 * CREATE INDEX. The indexes are created only in that throwaway database; any of them would need a
 * reviewed migration after Phase 1.
 *
 *   node test/perf/index-candidates.mjs <database-url>
 */
import pg from 'pg';

const url = process.argv[2];
const dbName = new URL(url).pathname.slice(1);
if (!/^rof_(e|perf)_[a-z0-9_]+$/.test(dbName)) throw new Error(`refusing ${dbName}: not a disposable database`);
const c = new pg.Client({ connectionString: url.replace(/\?.*$/, '') });
await c.connect();

const SENIOR = '00000000-0000-4000-8000-00000000a002';
const YEAR1 = '00000000-0000-4000-8000-0000000000e1';
const student = (await c.query(`SELECT id FROM "User" WHERE role = 'STUDENT' AND "isActive" AND "divisionId" = $1 ORDER BY username LIMIT 1`, [SENIOR])).rows[0].id;
const batch = (await c.query(`SELECT array_agg(id) ids FROM (SELECT id FROM "User" WHERE role = 'STUDENT' ORDER BY "lastName", "firstName", id LIMIT 2000) x`)).rows[0].ids;

const cases = [
  {
    name: 'leaderboard: one student\'s rank in the division (findMine)',
    sql: `SELECT * FROM (SELECT RANK() OVER (ORDER BY u."points" DESC, u."problemsSolved" DESC) AS rank, u.id FROM "User" u
           WHERE u.role = 'STUDENT' AND u."isActive" = true AND u."divisionId" = $1) r WHERE r.id = $2`,
    params: [SENIOR, student],
    index: `CREATE INDEX cand_user_division_rank ON "User" ("divisionId", "points" DESC, "problemsSolved" DESC) WHERE role = 'STUDENT' AND "isActive"`,
  },
  {
    name: 'leaderboard: first page of the division (findGeneral)',
    sql: `SELECT RANK() OVER (ORDER BY u."points" DESC, u."problemsSolved" DESC) AS rank, u.id FROM "User" u
           WHERE u.role = 'STUDENT' AND u."isActive" = true AND u."divisionId" = $1 ORDER BY rank, u."createdAt" LIMIT 20`,
    params: [SENIOR],
    index: null,   // same candidate as above
  },
  {
    name: 'admin user search (contains, case-insensitive, 4 columns)',
    sql: `SELECT id FROM "User" WHERE "firstName" ILIKE $1 OR "lastName" ILIKE $1 OR username ILIKE $1 OR email ILIKE $1 ORDER BY "createdAt" DESC LIMIT 20`,
    params: ['%mugisha%'],
    index: `CREATE EXTENSION IF NOT EXISTS pg_trgm;
            CREATE INDEX cand_user_first_trgm ON "User" USING gin ("firstName" gin_trgm_ops);
            CREATE INDEX cand_user_last_trgm  ON "User" USING gin ("lastName" gin_trgm_ops);
            CREATE INDEX cand_user_name_trgm  ON "User" USING gin (username gin_trgm_ops);
            CREATE INDEX cand_user_email_trgm ON "User" USING gin (email gin_trgm_ops)`,
  },
  {
    name: 'admin user search: rare term (one match)',
    sql: `SELECT count(*) FROM "User" WHERE "firstName" ILIKE $1 OR "lastName" ILIKE $1 OR username ILIKE $1 OR email ILIKE $1`,
    params: ['%student4242@%'],
    index: null,
  },
  {
    name: 'students.csv: submission counts of a 2,000-student batch',
    sql: `SELECT count(*), s."studentId", s.status FROM "Submission" s LEFT JOIN "Assignment" a ON a.id = s."assignmentId"
           WHERE s."studentId" = ANY($1) AND a."academicYearId" = $2 GROUP BY 2, 3`,
    params: [batch, YEAR1],
    index: `CREATE INDEX cand_submission_student_status ON "Submission" ("studentId", status, "assignmentId")`,
  },
];

const time = async (sql, params) => {
  let best = Infinity, plan;
  for (let i = 0; i < 3; i++) {
    const r = await c.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, params);
    const lines = r.rows.map((x) => x['QUERY PLAN']);
    const ms = Number(/Execution Time: ([\d.]+)/.exec(lines.at(-1))[1]);
    if (ms < best) { best = ms; plan = lines; }
  }
  return { ms: best, top: plan.slice(0, 6).map((l) => l.replace(/\s+/g, ' ').trim()) };
};

for (const k of cases) {
  const before = await time(k.sql, k.params);
  let created = null;
  if (k.index) {
    const t = Date.now();
    await c.query(k.index);
    await c.query('ANALYZE "User"; ANALYZE "Submission"');
    created = Date.now() - t;
  }
  const after = await time(k.sql, k.params);
  console.log(JSON.stringify({ case: k.name, beforeMs: before.ms, afterMs: after.ms, indexBuildMs: created, beforePlan: before.top, afterPlan: after.top }));
}
const sizes = await c.query(`SELECT indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) size FROM pg_stat_user_indexes WHERE indexrelname LIKE 'cand_%'`);
console.log(JSON.stringify({ indexSizes: sizes.rows }));
await c.end();
