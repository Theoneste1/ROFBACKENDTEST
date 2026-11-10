#!/usr/bin/env node
/**
 * Read-only reconciliation report for M8 (official school list, P1-11).
 *
 *   DATABASE_URL=... node scripts/school-reconciliation.mjs [--json] [--details]
 *
 * Runs inside BEGIN TRANSACTION READ ONLY (PostgreSQL refuses any write) and then
 * ROLLBACK. It applies exactly M8's rules to the CURRENT data, without changing it:
 *
 *   exact      an uncoded school whose normalised name matches exactly ONE official
 *              school, and no other uncoded school has that normalised name
 *              → M8 would ADOPT that code (same id, name and students)
 *   ambiguous  the name matches several official schools, or several uncoded schools
 *              share it, or the official code is already used → left uncoded
 *   unmatched  the name matches no official school → left uncoded
 *
 * For each group: schools, students (User.schoolId), enrolments
 * (StudentEnrollment.schoolId) and teacher school assignments (when M6 exists).
 * M8 never merges or deletes schools and never changes teacher assignments.
 * The official list is read from the M8 migration file itself (one source of truth).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const ROOT = join(import.meta.dirname, '..');
const M8 = readFileSync(join(ROOT, 'prisma/migrations/20261121000700_official_school_list/migration.sql'), 'utf8');
const start = M8.indexOf('INSERT INTO official_school');
const values = M8.slice(M8.indexOf('VALUES', start) + 'VALUES'.length, M8.indexOf(';\n', start)).trim();
const KEY = (col) => `trim(regexp_replace(translate(lower(${col}), 'àáâäãåçèéêëìíîïñòóôöõùúûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy'), '[^a-z0-9]+', ' ', 'g'))`;

const args = new Set(process.argv.slice(2));
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(2); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const has = async (table, column) => (await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND ($2::text IS NULL OR column_name = $2)`,
    [table, column ?? null])).rowCount > 0;
  const hasCode = await has('School', 'code');
  const hasTeacher = await has('TeacherSchoolAssignment');

  const sql = `
    WITH official(code, official, display, province, district, sector, ownership) AS (VALUES ${values}),
    o AS (SELECT code, ${KEY('official')} AS key FROM official),
    ex AS (SELECT s."id", s."name", ${KEY('s."name"')} AS k FROM "School" s ${hasCode ? 'WHERE s."code" IS NULL' : ''}),
    used AS (SELECT ${hasCode ? '"code"' : 'NULL::text AS code'} FROM "School" ${hasCode ? 'WHERE "code" IS NOT NULL' : 'WHERE false'}),
    c AS (
      SELECT ex."id", ex."name",
             (SELECT count(*) FROM o WHERE o.key = ex.k)::int AS officialMatches,
             (SELECT count(*) FROM ex e2 WHERE e2.k = ex.k)::int AS uncodedSameName,
             (SELECT string_agg(o.code, ',' ORDER BY o.code) FROM o WHERE o.key = ex.k) AS candidates,
             EXISTS (SELECT 1 FROM o JOIN used u ON u.code = o.code WHERE o.key = ex.k) AS codeTaken
        FROM ex
    )
    SELECT c.*,
           CASE WHEN c.officialMatches = 0 THEN 'unmatched'
                WHEN c.officialMatches = 1 AND c.uncodedSameName = 1 AND NOT c.codeTaken THEN 'exact'
                ELSE 'ambiguous' END AS category,
           (SELECT count(*) FROM "User" u WHERE u."schoolId" = c."id")::int AS students,
           (SELECT count(*) FROM "StudentEnrollment" e WHERE e."schoolId" = c."id")::int AS enrolments,
           ${hasTeacher ? `(SELECT count(*) FROM "TeacherSchoolAssignment" t WHERE t."schoolId" = c."id")::int` : '0'} AS teacherAssignments
      FROM c ORDER BY category, c."name"`;
  const rows = (await client.query(sql)).rows;
  const totals = async (q) => (await client.query(q)).rows[0];
  const all = await totals(`SELECT count(*)::int AS schools FROM "School"`);
  const coded = hasCode ? await totals(`SELECT count(*)::int AS n FROM "School" WHERE "code" IS NOT NULL`) : { n: 0 };
  const noSchool = await totals(`SELECT count(*)::int AS n FROM "User" WHERE "role" = 'STUDENT' AND "schoolId" IS NULL`);

  const sum = (cat) => {
    const r = rows.filter((x) => x.category === cat);
    return { schools: r.length, students: r.reduce((n, x) => n + x.students, 0), enrolments: r.reduce((n, x) => n + x.enrolments, 0), teacherAssignments: r.reduce((n, x) => n + x.teacherassignments, 0) };
  };
  const report = {
    database: { schools: all.schools, alreadyCoded: coded.n, studentsWithoutSchool: noSchool.n, m7Applied: hasCode, m6Applied: hasTeacher },
    exact: sum('exact'), ambiguous: sum('ambiguous'), unmatched: sum('unmatched'),
    m8WouldInsert: 1974 - sum('exact').schools - (coded.n),
    ...(args.has('--details') && {
      details: rows.map((x) => ({ id: x.id, name: x.name, category: x.category, officialCandidates: x.candidates?.split(',') ?? [], uncodedSameName: x.uncodedsamename, students: x.students, enrolments: x.enrolments, teacherAssignments: x.teacherassignments })),
    }),
  };
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('M8 reconciliation (read-only)');
    console.table(report.database);
    console.table({ exact: report.exact, ambiguous: report.ambiguous, unmatched: report.unmatched });
    console.log(`M8 would adopt ${report.exact.schools} existing school(s) and insert about ${report.m8WouldInsert} official school(s).`);
    if (report.details) console.table(report.details.filter((d) => d.category !== 'exact'));
  }
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end();
}
