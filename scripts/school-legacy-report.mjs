#!/usr/bin/env node
/**
 * Read-only LEGACY school report for M11 (school administration PR B).
 *
 *   node scripts/db-drill-verify.mjs --check-target          # first: the target guard (restore copy only)
 *   DATABASE_URL=... node scripts/school-legacy-report.mjs [--json] [--details]
 *
 * Runs inside BEGIN TRANSACTION READ ONLY (PostgreSQL refuses any write), then ROLLBACK.
 * Works before M11 (it classifies as M11's backfill will: a school without a code becomes
 * LEGACY) and after it (it reads the source column).
 *
 * For every LEGACY school: students (User.schoolId), current claims by status, enrolments and
 * active Teacher assignments — what an Administrator has to review (give it a place / code,
 * or deactivate it) once PR B is deployed. Nothing is changed; no names or e-mails of students
 * are printed (school names only).
 */
import pg from 'pg';

const args = new Set(process.argv.slice(2));
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(2); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN TRANSACTION READ ONLY');
  const has = async (table, column) => (await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND ($2::text IS NULL OR column_name = $2)`,
    [table, column ?? null])).rowCount > 0;
  const m11 = await has('School', 'source');
  const m9 = await has('StudentSchoolAffiliation');
  const m6 = await has('TeacherSchoolAssignment');

  const legacyWhere = m11 ? `s."source" = 'LEGACY'` : `s."code" IS NULL`;
  const claims = (status) => m9
    ? `(SELECT count(*) FROM "StudentSchoolAffiliation" a WHERE a."schoolId" = s."id" AND a."supersededAt" IS NULL AND a."status" = '${status}')::int`
    : '0';
  const rows = (await client.query(`
    SELECT s."id", s."name", s."location",
           (SELECT count(*) FROM "User" u WHERE u."schoolId" = s."id" AND u."role" = 'STUDENT')::int AS students,
           ${claims('PENDING')} AS pending, ${claims('VERIFIED')} AS verified,
           ${claims('REJECTED')} AS rejected, ${claims('REVOKED')} AS revoked,
           (SELECT count(*) FROM "StudentEnrollment" e WHERE e."schoolId" = s."id")::int AS enrolments,
           ${m6 ? `(SELECT count(*) FROM "TeacherSchoolAssignment" t WHERE t."schoolId" = s."id" AND t."isActive")::int` : '0'} AS teachers
      FROM "School" s
     WHERE ${legacyWhere}
     ORDER BY s."name"`)).rows;
  const total = (await client.query(`SELECT count(*)::int AS n FROM "School"`)).rows[0].n;
  const sum = (k) => rows.reduce((n, r) => n + r[k], 0);

  const report = {
    database: { schools: total, m11Applied: m11, m9Applied: m9 },
    legacy: {
      schools: rows.length, withStudents: rows.filter((r) => r.students > 0).length,
      students: sum('students'), pendingClaims: sum('pending'), verifiedClaims: sum('verified'),
      enrolments: sum('enrolments'), activeTeacherAssignments: sum('teachers'),
    },
    ...(args.has('--details') && { details: rows }),
  };
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('LEGACY schools (read-only)');
    console.table(report.database);
    console.table(report.legacy);
    if (report.details) console.table(report.details);
  }
} finally {
  await client.query('ROLLBACK').catch(() => undefined);
  await client.end();
}
