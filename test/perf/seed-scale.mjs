#!/usr/bin/env node
/**
 * Scale seed (NOT part of CI): EMPTIES and fills a MIGRATED, DISPOSABLE database with a realistic
 * ~N-student platform, in set-based SQL (seeding is not what is measured).
 *
 *   node test/perf/seed-scale.mjs <database-url> <students>
 *
 * Refuses any database whose name does not start with `rof_e_` or `rof_perf_`.
 *
 * Shape (per N students):
 *   - 1 programme (Mathematics), 2 divisions, 4 courses; current year 2026-2027 + a PLANNED 2027-2028
 *   - N/200 schools (min 50); students S1–S6 evenly, 3% suspended, 1% without any enrolment
 *     ("created before years existed": the rollover's unenrolled sweep), 60% with a VERIFIED school claim
 *   - 10 coaches per course × division (80), 1 admin (username `admin`)
 *   - 40 assignments per division (10 per course), current year, PUBLISHED / CLOSED
 *   - ~30% of active students submit each assignment; status mix 70% PUBLISHED, 10% APPROVED,
 *     10% ASSIGNED / IN_REVIEW, 10% SUBMITTED; every reviewed submission has a MentorReview
 *   - BIG_PUBLISH (Senior × Algebra): min(30,000, 60% of active Senior students) APPROVED
 *   - BIG_DISTRIBUTE (Senior × Algebra): the same number SUBMITTED
 *   - ~8 activity-log rows per active student over the last 30 days (half the students active)
 *   - points / problemsSolved consistent with the published results
 */
import pg from 'pg';
import bcrypt from 'bcrypt';

const [url, nArg] = process.argv.slice(2);
const N = Number(nArg);
if (!url || !Number.isInteger(N) || N < 100) {
  console.error('usage: seed-scale.mjs <database-url> <students>');
  process.exit(2);
}
const dbName = new URL(url).pathname.slice(1);
if (!/^rof_(e|perf)_[a-z0-9_]+$/.test(dbName)) throw new Error(`refusing to seed ${dbName}: not a disposable rof_e_/rof_perf_ database`);

const c = new pg.Client({ connectionString: url.replace(/\?.*$/, '') });
await c.connect();
const t0 = Date.now();
const step = async (label, sql, params = []) => {
  const s = Date.now();
  const r = await c.query(sql, params);
  console.log(`${label.padEnd(34)} ${String(r.rowCount ?? '').padStart(9)} rows  ${((Date.now() - s) / 1000).toFixed(1)} s`);
  return r;
};

// Start from empty tables (migrations seed reference rows: discipline, a year, the official school list).
const tables = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`)).rows;
await c.query(`TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);

const hash = await bcrypt.hash('Passw0rd!', 4);
const SCHOOLS = Math.max(50, Math.floor(N / 200));

await c.query('BEGIN');
await c.query(`SET LOCAL synchronous_commit = off`);

await step('reference data', `
  WITH d AS (INSERT INTO "Discipline" (id, code, name, "updatedAt") VALUES ('00000000-0000-4000-8000-00000000d001', 'MATHEMATICS', 'Mathematics', now()) RETURNING id)
  INSERT INTO "Division" (id, code, name, "updatedAt") VALUES
    ('00000000-0000-4000-8000-00000000a001', 'JUNIOR', 'Junior', now()),
    ('00000000-0000-4000-8000-00000000a002', 'SENIOR', 'Senior', now())`);
await step('courses', `
  INSERT INTO "Course" (id, code, "disciplineId", title, description, "sortOrder", status, "publishedAt", "updatedAt")
  SELECT '00000000-0000-4000-8000-0000000000c' || i, code, '00000000-0000-4000-8000-00000000d001', replace(code, '_', ' '), code || ' course', i, 'PUBLISHED', now(), now()
    FROM unnest(ARRAY['ALGEBRA','GEOMETRY','NUMBER_THEORY','COMBINATORICS']) WITH ORDINALITY AS t(code, i)`);
await step('academic years', `
  INSERT INTO "AcademicYear" (id, name, "startsOn", "endsOn", status, "isCurrent", "updatedAt") VALUES
    ('00000000-0000-4000-8000-0000000000e1', '2026-2027', '2026-09-01', '2027-07-31', 'ACTIVE', true, now()),
    ('00000000-0000-4000-8000-0000000000e2', '2027-2028', '2027-09-01', '2028-07-31', 'PLANNED', NULL, now())`);
await step('schools', `
  INSERT INTO "School" (id, name, location, "nameKey")
  SELECT gen_random_uuid()::text, 'School ' || i, 'District ' || (i % 30), 'school ' || i FROM generate_series(1, $1) i`, [SCHOOLS]);

await step('admin + coaches', `
  INSERT INTO "User" (id, "firstName", "lastName", username, email, "passwordHash", role, "activatedAt", "updatedAt")
  SELECT '00000000-0000-4000-8000-0000000000ad', 'Admin', 'Scale', 'admin', 'admin@scale.local', $1, 'ADMIN'::"Role", now(), now()
  UNION ALL
  SELECT gen_random_uuid()::text, 'Coach' || i, 'Scale', 'coach' || i, 'coach' || i || '@scale.local', $1, 'MENTOR'::"Role", now(), now()
    FROM generate_series(1, 80) i`, [hash]);
await step('coach assignments', `
  INSERT INTO "MentorAssignment" (id, "mentorId", "courseId", "divisionId", "updatedAt")
  SELECT gen_random_uuid()::text, m.id, c.id, d.id, now()
    FROM (SELECT id, row_number() OVER (ORDER BY username) - 1 AS k FROM "User" WHERE role = 'MENTOR') m
    JOIN (SELECT id, row_number() OVER (ORDER BY "sortOrder") - 1 AS ci FROM "Course") c ON c.ci = (m.k / 10) % 4
    JOIN (SELECT id, row_number() OVER (ORDER BY code) - 1 AS di FROM "Division") d ON d.di = (m.k / 40)`);

// Students: grade by i % 6; deterministic last names so that search / ordering are realistic.
await step('students', `
  WITH sch AS (SELECT id, row_number() OVER (ORDER BY name) - 1 AS k FROM "School")
  INSERT INTO "User" (id, "firstName", "lastName", username, email, "passwordHash", role, "isActive", "activatedAt",
                      "gradeLevel", "divisionId", "schoolId", "createdAt", "updatedAt", "lastLoginAt")
  SELECT gen_random_uuid()::text,
         (ARRAY['Aline','Eric','Grace','Jean','Diane','Patrick','Claudine','Emmanuel','Josiane','Olivier'])[1 + i % 10] || i,
         (ARRAY['Uwase','Mugisha','Niyonzima','Habimana','Mukamana','Nshimiyimana','Ingabire','Tuyishime','Iradukunda','Hakizimana'])[1 + (i / 10) % 10],
         'student' || i, 'student' || i || '@scale.local', $2, 'STUDENT',
         (i % 33) <> 0,                                    -- ~3% suspended
         now() - ((i % 300) || ' days')::interval,
         ('S' || (1 + i % 6))::"GradeLevel",
         CASE WHEN i % 6 < 3 THEN '00000000-0000-4000-8000-00000000a001' ELSE '00000000-0000-4000-8000-00000000a002' END,
         sch.id,
         now() - ((i % 400) || ' days')::interval, now(),
         CASE WHEN i % 2 = 0 THEN now() - ((i % 20) || ' days')::interval END
    FROM generate_series(1, $1) i JOIN sch ON sch.k = i % $3`, [N, hash, SCHOOLS]);

await step('current-year enrolments', `
  INSERT INTO "StudentEnrollment" (id, "studentId", "academicYearId", "divisionId", "gradeLevel", "schoolId", status, "enrolledAt")
  SELECT gen_random_uuid()::text, u.id, '00000000-0000-4000-8000-0000000000e1', u."divisionId", u."gradeLevel", u."schoolId", 'ACTIVE', '2026-09-01'
    FROM "User" u WHERE u.role = 'STUDENT' AND (hashtext(u.id) % 100) <> 0`);   // ~1% never enrolled
await step('verified school claims (60%)', `
  INSERT INTO "StudentSchoolAffiliation" (id, "studentId", "schoolId", status, source, "decidedAt")
  SELECT gen_random_uuid()::text, u.id, u."schoolId", 'VERIFIED', 'MIGRATION', now()
    FROM "User" u WHERE u.role = 'STUDENT' AND abs(hashtext(u.id || 'aff')) % 100 < 60`);
await step('programme memberships', `
  INSERT INTO "ProgrammeMembership" (id, "userId", "disciplineId", source)
  SELECT gen_random_uuid()::text, id, '00000000-0000-4000-8000-00000000d001', 'BACKFILL' FROM "User" WHERE role IN ('STUDENT', 'MENTOR')`);
await step('course enrolments', `
  INSERT INTO "CourseEnrollment" (id, "courseId", "studentId", status, "completedAt")
  SELECT gen_random_uuid()::text, c.id, u.id,
         CASE WHEN abs(hashtext(u.id || c.id)) % 10 < 3 THEN 'COMPLETED' ELSE 'ROLLED' END::"CourseEnrollmentStatus",
         CASE WHEN abs(hashtext(u.id || c.id)) % 10 < 3 THEN now() END
    FROM "User" u CROSS JOIN "Course" c
   WHERE u.role = 'STUDENT' AND abs(hashtext(u.id || c.id)) % 2 = 0`);

// 40 assignments per division (10 per course), deadlines spread over the past months.
await step('assignments', `
  INSERT INTO "Assignment" (id, title, instructions, deadline, points, "maximumMarks", status, "publishedAt", "closedAt",
                            "courseId", "divisionId", "academicYearId", "createdById", "updatedAt")
  SELECT gen_random_uuid()::text, c.code || ' ' || d.code || ' problem set ' || k, 'Solve.',
         now() - ((5 + k * 6) || ' days')::interval, 10, 100,
         CASE WHEN k % 3 = 0 THEN 'CLOSED' ELSE 'PUBLISHED' END::"AssignmentStatus",
         now() - ((20 + k * 6) || ' days')::interval,
         CASE WHEN k % 3 = 0 THEN now() - ((5 + k * 6) || ' days')::interval END,
         c.id, d.id, '00000000-0000-4000-8000-0000000000e1',
         (SELECT "mentorId" FROM "MentorAssignment" ma WHERE ma."courseId" = c.id AND ma."divisionId" = d.id LIMIT 1), now()
    FROM "Course" c CROSS JOIN "Division" d CROSS JOIN generate_series(1, 10) k`);
await step('big assignments', `
  INSERT INTO "Assignment" (id, title, instructions, deadline, points, "maximumMarks", status, "publishedAt",
                            "courseId", "divisionId", "academicYearId", "createdById", "updatedAt")
  SELECT id, title, 'Solve.', now() - interval '2 days', 10, 100, 'PUBLISHED', now() - interval '20 days',
         '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000a002', '00000000-0000-4000-8000-0000000000e1',
         (SELECT "mentorId" FROM "MentorAssignment" WHERE "courseId" = '00000000-0000-4000-8000-0000000000c1' AND "divisionId" = '00000000-0000-4000-8000-00000000a002' LIMIT 1), now()
    FROM (VALUES ('00000000-0000-4000-8000-0000000000b1', 'BIG_PUBLISH'), ('00000000-0000-4000-8000-0000000000b2', 'BIG_DISTRIBUTE')) v(id, title)`);

// Regular submissions: ~30% of the division's active students per assignment.
// h = a stable per-(assignment, student) hash; its buckets choose the status.
await step('submissions (regular)', `
  INSERT INTO "Submission" (id, status, "assignmentId", "studentId", "revisionCount", "isLate", "submittedAt", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text,
         CASE WHEN h < 21 THEN 'PUBLISHED' WHEN h < 24 THEN 'APPROVED' WHEN h < 25 THEN 'ASSIGNED' WHEN h < 27 THEN 'IN_REVIEW' ELSE 'SUBMITTED' END::"SubmissionStatus",
         a.id, u.id, 1, h % 10 = 0, a.deadline - interval '1 day', a.deadline - interval '1 day', now()
    FROM "Assignment" a
    JOIN "User" u ON u."divisionId" = a."divisionId" AND u.role = 'STUDENT' AND u."isActive"
    CROSS JOIN LATERAL (SELECT abs(hashtext(a.id || u.id)) % 100 AS h) x
   WHERE a.title NOT LIKE 'BIG_%' AND x.h < 30`);
await step('submissions (BIG_PUBLISH / BIG_DISTRIBUTE)', `
  INSERT INTO "Submission" (id, status, "assignmentId", "studentId", "revisionCount", "isLate", "submittedAt", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, CASE WHEN a.title = 'BIG_PUBLISH' THEN 'APPROVED' ELSE 'SUBMITTED' END::"SubmissionStatus",
         a.id, s.id, 1, false, now() - interval '3 days' + (s.rn || ' seconds')::interval, now() - interval '3 days', now()
    FROM "Assignment" a
    CROSS JOIN LATERAL (
      SELECT u.id, row_number() OVER (ORDER BY u.id) rn FROM "User" u
       WHERE u."divisionId" = a."divisionId" AND u.role = 'STUDENT' AND u."isActive"
       ORDER BY u.id
       LIMIT LEAST(30000, (SELECT (count(*) * 0.6)::int FROM "User" WHERE "divisionId" = a."divisionId" AND role = 'STUDENT' AND "isActive"))
    ) s
   WHERE a.title IN ('BIG_PUBLISH', 'BIG_DISTRIBUTE')`);

// One review cycle per reviewed submission, by a coach of the course × division.
await step('mentor reviews', `
  INSERT INTO "MentorReview" (id, "submissionId", cycle, "mentorId", status, score, percentage, feedback, "assignedAt", "startedAt",
                              "markedAt", "returnedAt", "decidedAt", "publishedAt", "createdAt", "updatedAt")
  SELECT gen_random_uuid()::text, s.id, 1, m."mentorId",
         CASE s.status WHEN 'PUBLISHED' THEN 'PUBLISHED' WHEN 'APPROVED' THEN 'APPROVED' WHEN 'IN_REVIEW' THEN 'IN_PROGRESS' ELSE 'ASSIGNED' END::"ReviewStatus",
         CASE WHEN s.status IN ('PUBLISHED','APPROVED') THEN sc END, CASE WHEN s.status IN ('PUBLISHED','APPROVED') THEN sc END,
         CASE WHEN s.status IN ('PUBLISHED','APPROVED') THEN 'Good work.' END,
         s."submittedAt" + interval '1 day', s."submittedAt" + interval '1 day',
         CASE WHEN s.status IN ('PUBLISHED','APPROVED') THEN s."submittedAt" + interval '2 days' END,
         CASE WHEN s.status IN ('PUBLISHED','APPROVED') THEN s."submittedAt" + interval '2 days' END,
         CASE WHEN s.status IN ('PUBLISHED','APPROVED') THEN s."submittedAt" + interval '3 days' END,
         CASE WHEN s.status = 'PUBLISHED' THEN s."submittedAt" + interval '4 days' END,
         s."submittedAt" + interval '1 day', now()
    FROM "Submission" s JOIN "Assignment" a ON a.id = s."assignmentId"
    CROSS JOIN LATERAL (SELECT abs(hashtext(s.id)) % 101 AS sc) x
    CROSS JOIN LATERAL (
      SELECT "mentorId" FROM "MentorAssignment" ma WHERE ma."courseId" = a."courseId" AND ma."divisionId" = a."divisionId"
       ORDER BY ma."mentorId" OFFSET abs(hashtext(s.id || 'm')) % 10 LIMIT 1) m
   WHERE s.status <> 'SUBMITTED'`);
await step('submission → review links', `
  UPDATE "Submission" s
     SET "currentReviewId" = r.id,
         "publishedReviewId" = CASE WHEN s.status = 'PUBLISHED' THEN r.id END,
         "pointsAwarded" = CASE WHEN s.status = 'PUBLISHED' THEN round(r.score * 10 / 100.0)::int ELSE 0 END,
         "publishedAt" = CASE WHEN s.status = 'PUBLISHED' THEN r."publishedAt" END
    FROM "MentorReview" r WHERE r."submissionId" = s.id`);
await step('result releases', `
  WITH rel AS (
    INSERT INTO "ResultRelease" (id, "assignmentId", "publishedById", "resultCount", "publishedAt")
    SELECT gen_random_uuid()::text, "assignmentId", '00000000-0000-4000-8000-0000000000ad', count(*), max("publishedAt")
      FROM "Submission" WHERE status = 'PUBLISHED' GROUP BY "assignmentId" RETURNING id, "assignmentId")
  UPDATE "Submission" s SET "resultReleaseId" = rel.id FROM rel WHERE rel."assignmentId" = s."assignmentId" AND s.status = 'PUBLISHED'`);
await step('assignment resultsPublishedAt', `
  UPDATE "Assignment" a SET "resultsPublishedAt" = r."publishedAt" FROM "ResultRelease" r WHERE r."assignmentId" = a.id`);
await step('points cache', `
  WITH t AS (SELECT "studentId", sum("pointsAwarded")::int p, count(*)::int n FROM "Submission" WHERE status = 'PUBLISHED' GROUP BY 1)
  UPDATE "User" u SET points = t.p, "problemsSolved" = t.n FROM t WHERE t."studentId" = u.id`);
await step('activity log (30 days)', `
  INSERT INTO "ActivityLog" (id, "userId", type, "courseId", "createdAt")
  SELECT gen_random_uuid()::text, u.id,
         (ARRAY['LOGIN','COURSE_OPENED','RESOURCE_VIEWED','ASSIGNMENT_VIEWED','RESULT_VIEWED'])[1 + k % 5]::"ActivityType",
         CASE WHEN k % 5 IN (1, 2) THEN '00000000-0000-4000-8000-0000000000c' || (1 + k % 4) END,
         now() - ((abs(hashtext(u.id || k)) % 43200) || ' minutes')::interval
    FROM "User" u CROSS JOIN generate_series(1, 8) k
   WHERE u.role = 'STUDENT' AND u."isActive" AND abs(hashtext(u.id)) % 2 = 0`);

await c.query('COMMIT');
await step('vacuum analyze', 'VACUUM ANALYZE');
const sizes = await c.query(`
  SELECT (SELECT count(*) FROM "User" WHERE role = 'STUDENT')::int students,
         (SELECT count(*) FROM "User" WHERE role = 'STUDENT' AND "isActive")::int active_students,
         (SELECT count(*) FROM "StudentEnrollment")::int enrolments,
         (SELECT count(*) FROM "Assignment")::int assignments,
         (SELECT count(*) FROM "Submission")::int submissions,
         (SELECT count(*) FROM "MentorReview")::int reviews,
         (SELECT count(*) FROM "ActivityLog")::int activity,
         pg_size_pretty(pg_database_size(current_database())) db_size`);
console.log(JSON.stringify(sizes.rows[0]));
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await c.end();
