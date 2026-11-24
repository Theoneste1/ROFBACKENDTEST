/**
 * Release kit (scripts/release/rehearsal.mjs): the rollback can be interrupted at ANY file and resumed, against a real
 * PostgreSQL. Staging rehearsal 2026-11-19: `rollback --release post-phase1` stopped at the registration-details guard
 * after seven newer rollbacks had run; running it again failed at once on a table those rollbacks had already dropped.
 *
 * For every release the kit supports and whose migrations this checkout has (phase1, post-phase1, areas-2026, late-2026,
 * dec-2026, levels-2026, launch-2026, email-2026):
 *  - each migration's object list equals what its SQL changes in the catalogue, and names every object its SQL names;
 *  - a fresh database is migrated to the release's state and seeded, including data that makes EVERY guard refuse;
 *  - a clean full rollback (all acknowledgements) is the reference: every object gone (schema = before the release, but
 *    for what the rollback files deliberately keep), the pre-release data unchanged, rollback-history works and
 *    re-applying the release gives the same schema;
 *  - interrupted after file k, for every k: guards still refuse without (or with a different) acknowledgement and then
 *    change nothing; resumed, the end state equals the reference; rollback-history and re-apply work;
 *  - interrupted by each guard in turn (the staging case: the newer migrations already rolled back, their tables gone):
 *    the same command refuses again at the same guard and changes nothing; with the acknowledgement (or PGOPTIONS) it completes;
 *  - half-rolled-back migrations (a table dropped but its column or trigger left, an index left, a dropped index restored)
 *    and an out-of-order state are refused, naming what remains, and nothing changes;
 *  - a check-only migration (20261220000000_test_file_purposes: its rollback keeps its enum values and changes nothing) has
 *    its file run every time, so its guard is never skipped;
 *  - --acknowledge accepts only the fixed allow-list; PG_BIN is validated.
 *
 * Every database here is created next to TEST_DATABASE_URL under a random rk_* name and dropped afterwards; the shared test
 * database is only used to issue CREATE / DROP DATABASE (its schema and data are never touched).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from 'pg';

const ROOT = join(__dirname, '..');
type Any = any;
const load = (p: string): Promise<Any> => import(/* @vite-ignore */ pathToFileURL(join(ROOT, p)).href);

let kit: Any;
let rel: Any;
let cat: Any;
let db: Any;
const ADMIN = process.env.TEST_DATABASE_URL as string;
const created: string[] = [];
const allDirs = readdirSync(join(ROOT, 'prisma/migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

beforeAll(async () => {
  [kit, rel, cat, db] = await Promise.all([load('scripts/release/rehearsal.mjs'), load('scripts/release/releases.mjs'),
    load('scripts/release/catalog.mjs'), load('test/support/release-db.mjs')]);
});

afterAll(async () => {
  for (const name of [...created]) await drop(name);
}, 600_000);

/** Drops a database this file created (scenario databases are dropped as soon as they are checked). */
async function drop(name: string) {
  await db.dropDatabase(ADMIN, name);
  created.splice(created.indexOf(name), 1);
}

const url = (name: string) => db.databaseUrl(ADMIN, name);
async function newDb(prefix: string, template?: string) {
  const name = db.randomName(prefix);
  created.push(name);
  await db.createDatabase(ADMIN, name, template);
  return name;
}
const withDb = <T>(name: string, fn: (c: Client) => Promise<T>): Promise<T> => db.withClient(url(name), fn);

// ── Fingerprints ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The schema of public, one line per column (type, null, default), constraint, index, trigger, function and enum. */
async function schemaOf(c: Client): Promise<string[]> {
  const { rows } = await c.query(`
    SELECT 'column ' || k.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
           || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '') AS l
      FROM pg_attribute a JOIN pg_class k ON k.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE k.relnamespace = 'public'::regnamespace AND k.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped AND k.relname <> '_prisma_migrations'
    UNION ALL SELECT 'constraint ' || k.relname || '.' || n.conname || ' ' || pg_get_constraintdef(n.oid)
      FROM pg_constraint n JOIN pg_class k ON k.oid = n.conrelid WHERE k.relnamespace = 'public'::regnamespace AND n.contype IN ('p', 'f', 'u', 'c', 'x') AND k.relname <> '_prisma_migrations'
    UNION ALL SELECT 'index ' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    UNION ALL SELECT 'trigger ' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class k ON k.oid = t.tgrelid WHERE k.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal
    UNION ALL SELECT 'function ' || p.proname || ' ' || md5(pg_get_functiondef(p.oid)) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
    UNION ALL SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace = 'public'::regnamespace GROUP BY t.typname`);
  return rows.map((r) => r.l as string).sort();
}

/** Values written with now() / gen_random_uuid() by the rollback files themselves: left out when comparing two runs. */
const VOLATILE: Record<string, string[]> = { AuditLog: ['id', 'createdAt'], UserPermissionOverride: ['revokedAt'], SystemSetting: ['updatedAt'] };

async function tablesOf(c: Client): Promise<string[]> {
  const { rows } = await c.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> '_prisma_migrations' ORDER BY 1`);
  return rows.map((r) => r.relname);
}

/** Every row of every table (volatile values left out), as sorted hashes per table; plus the history names. */
async function dataOf(c: Client): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const t of await tablesOf(c)) {
    const { rows } = await c.query(`SELECT md5((to_jsonb(x) - $1::text[])::text) AS h FROM "${t}" x`, [VOLATILE[t] ?? []]);
    out[t] = rows.map((r) => r.h).sort();
  }
  const has = (await c.query(`SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS ok`)).rows[0].ok;
  out._history = has ? (await c.query('SELECT migration_name FROM "_prisma_migrations" ORDER BY 1')).rows.map((r) => r.migration_name) : [];
  return out;
}

/** Every row by primary key (all columns), to prove the rows that existed before the release are unchanged. */
async function rowsByKey(c: Client): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const t of await tablesOf(c)) {
    const pk = (await c.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY a.attname`, [`"${t}"`])).rows.map((r) => r.attname);
    const key = pk.length ? `jsonb_build_array(${pk.map((k) => `x."${k}"`).join(', ')})::text` : 'md5(to_jsonb(x)::text)';
    for (const r of (await c.query(`SELECT ${key} AS k, md5(to_jsonb(x)::text) AS h FROM "${t}" x`)).rows) out.set(`${t} ${r.k}`, r.h);
  }
  return out;
}

const state = async (name: string) => withDb(name, async (c) => ({ schema: await schemaOf(c), data: await dataOf(c) }));

// ── Releases under test ─────────────────────────────────────────────────────────────────────────────────────────────

type Seed = (c: Client) => Promise<void>;
const val = async (c: Client, sql: string) => Object.values((await c.query(sql)).rows[0] ?? {})[0];

/** Rows that exist BEFORE the release (ids "pre-…"): never changed by deploying and rolling back the release. */
async function seedPre(c: Client) {
  const has = async (t: string) => Boolean(await val(c, `SELECT to_regclass('public."${t}"') IS NOT NULL`));
  for (const [id, role] of [['pre-user-1', 'MENTOR'], ['pre-user-2', 'MENTOR'], ['pre-user-3', 'ADMIN']]) {
    await c.query(`INSERT INTO "User" ("id", "firstName", "lastName", "username", "email", "role", "updatedAt")
      VALUES ($1, 'Rehearsal', $1, $1, $1 || '@example.invalid', $2, '2026-01-01')`, [id, role]);
  }
  await c.query(`INSERT INTO "School" ("id", "name", "location") VALUES ('pre-school-1', 'Rehearsal School', 'Kigali')`);
  await c.query(`INSERT INTO "MentorRequest" ("id", "firstName", "lastName", "username", "email", "updatedAt")
    VALUES ('pre-mr-1', 'Coach', 'Applicant', 'pre-coach', 'pre-coach@example.invalid', '2026-01-01')`);
  await c.query(`INSERT INTO "FileObject" ("id", "storageKey", "purpose", "originalName", "mimeType", "size", "sha256")
    VALUES ('pre-file-1', 'pre/file-1', 'RESOURCE', 'a.png', 'image/png', 1, repeat('0', 64))`);
  if (await has('UserPermissionOverride')) {
    await c.query(`INSERT INTO "UserPermissionOverride" ("id", "userId", "permission", "effect", "reason")
      VALUES ('pre-upo-1', 'pre-user-1', 'students.viewProfile', 'GRANT', 'school-wide delegation before the release')`);
  }
  if (await has('TeacherSchoolAssignment')) {
    await c.query(`INSERT INTO "TeacherSchoolAssignment" ("id", "teacherId", "schoolId") VALUES ('pre-tsa-1', 'pre-user-1', 'pre-school-1')`);
  }
}

/** Release-time data (ids "rel-…") that makes every guard of the release refuse without its acknowledgement. */
const SEEDS: Record<string, Seed> = {
  phase1: async (c) => {
    await c.query(`UPDATE "School" SET "cell" = 'Rehearsal cell' WHERE "id" = 'pre-school-1'`);                                  // M12
    await c.query(`INSERT INTO "SchoolSyncRun" ("id", "datasetKey", "normaliserVersion", "dataSourceId", "datasetLabel", "fileName",
      "fileSha256", "format", "rowCount", "reconciliation", "counts", "reportDigest", "decisionsDigest", "comparedAt", "expiresAt", "approvedAt")
      SELECT 'rel-run-1', 'rehearsal', '1', "id", 'Rehearsal', 'r.csv', repeat('0', 64), 'csv', 0, '{}', '{}', 'd', 'd', now(), now() + interval '1 day', now()
        FROM "SchoolDataSource" ORDER BY "id" LIMIT 1`);                                                                             // M13, M14
  },
  'post-phase1': async (c) => {
    await c.query(`UPDATE "User" SET "phone" = '+250700000001' WHERE "id" = 'pre-user-2'`);                                         // teacher applications
    await c.query(`INSERT INTO "NotificationOutbox" ("id", "type", "dedupeKey", "recipientEmail", "firstName", "entityType", "entityId", "payload")
      VALUES ('rel-outbox-1', 'REHEARSAL', 'rel-outbox-1', 'x@example.invalid', 'X', 'User', 'pre-user-2', '{}')`);                // notification outbox
    await c.query(`UPDATE "User" SET "olympiadInterests" = (enum_range(NULL::"OlympiadSubject"))[1:1] WHERE "id" = 'pre-user-2'`); // olympiad interests
    await c.query(`UPDATE "User" SET "dateOfBirth" = '2010-01-01' WHERE "id" = 'pre-user-2'`);                                     // registration details
    await c.query(`UPDATE "User" SET "avatarFileId" = 'pre-file-1' WHERE "id" = 'pre-user-2'`);                                    // profile pictures
    await c.query(`INSERT INTO "UserStatusChange" ("id", "userId", "fromStatus", "toStatus", "actorRole")
      VALUES ('rel-status-1', 'pre-user-2', 'ACTIVE', 'SUSPENDED', 'ADMIN')`);                                                     // account states
    await c.query(`INSERT INTO "BulkOperation" ("id", "actorRole", "action", "params", "selection", "selectionToken", "total", "idempotencyKey")
      VALUES ('rel-bulk-1', 'ADMIN', 'DEACTIVATE', '{}', '{}', 't', 0, 'rel-bulk-1')`);                                             // bulk operations
    await c.query(`UPDATE "FormAvailability" SET "closedMessage" = 'Closed for the rehearsal' WHERE "key" = 'CONTACT'`);             // form settings
    await c.query(`UPDATE "MentorRequest" SET "phone" = '+250700000002' WHERE "id" = 'pre-mr-1'`);                                  // application details
    await c.query(`INSERT INTO "UserPermissionOverride" ("id", "userId", "permission", "effect", "reason", "studentScope")
      VALUES ('rel-upo-1', 'pre-user-2', 'students.viewProfile', 'GRANT', 'narrowed delegation', 'ASSIGNED')`);
    await c.query(`INSERT INTO "TeacherStudentAssignment" ("id", "teacherId", "studentId", "updatedAt")
      VALUES ('rel-tsa-1', 'pre-user-1', 'pre-user-2', now())`);                                                                    // teacher-student access
  },
  'areas-2026': async (c) => {
    await c.query(`UPDATE "Country" SET "updatedAt" = "updatedAt" + interval '1 day' WHERE "code" = (SELECT min("code") FROM "Country")`); // country edits
    await c.query(`INSERT INTO "AuditLog" ("id", "action", "entity", "entityId") VALUES ('rel-audit-1', 'TEACHER_PRIMARY_ASSIGNED', 'TeacherSchoolAssignment', 'pre-tsa-1')`);
    await c.query(`INSERT INTO "FileObject" ("id", "storageKey", "purpose", "originalName", "mimeType", "size", "sha256")
      VALUES ('rel-file-paper', 'rel/paper', 'TEST_PAPER', 'paper.pdf', 'application/pdf', 1, repeat('1', 64))`);                 // test files
    await seedTestAndSubmission(c);                                                                                                 // tests, submissions
    await c.query(`INSERT INTO "TestMarkerAssignment" ("id", "submissionId", "kind", "coachId", "assignedAt", "method")
      VALUES ('rel-tma-1', 'rel-sub-1', 'FIRST', 'pre-user-1', '2026-12-03', 'MANUAL')`);                                          // marking
    await c.query(`INSERT INTO "TestPublication" ("id", "testId", "number", "actorRole", "publishedCount", "counts", "createdAt")
      VALUES ('rel-pub-1', 'rel-test-1', 1, 'ADMIN', 0, '{}', '2026-12-04')`);                                                      // publications
  },
  'late-2026': async (c) => {
    await c.query(`UPDATE "User" SET "gender" = (enum_range(NULL::"Gender"))[1] WHERE "id" = 'pre-user-2'`);                       // genders
    await c.query(`UPDATE "MentorRequest" SET "homeDistrict" = 'Gasabo' WHERE "id" = 'pre-mr-1'`);                                  // home places
    await c.query(`INSERT INTO "BulkOperation" ("id", "actorRole", "action", "params", "selection", "selectionToken", "total", "idempotencyKey", "entityType")
      VALUES ('rel-bulk-school', 'ADMIN', 'DEACTIVATE', '{}', '{}', 'rel-school', 0, 'rel-bulk-school', 'SCHOOL')`);             // non-user bulk operations
  },
  'dec-2026': async (c) => {
    await c.query(`UPDATE "User" SET "olympiadInterestOther" = 'Astronomy' WHERE "id" = 'pre-user-2'`);                            // other Olympiad
    await seedTestAndSubmission(c);
    await c.query(`INSERT INTO "TestResubmissionAuthorization" ("id", "submissionId", "reason")
      VALUES ('rel-rsa-1', 'rel-sub-1', 'One more version for the rehearsal')`);                                                    // resubmission authorizations
  },
  'levels-2026': async (c) => {
    await c.query(`UPDATE "User" SET "divisionManual" = true WHERE "id" = 'pre-user-2'`);                                           // classifications
    await c.query(`INSERT INTO "CustomReport" ("id", "name", "source", "columns", "filters", "sort", "updatedAt")
      VALUES ('rel-report-1', 'Rehearsal report', 'users', '[]', '[]', '[]', '2026-12-05')`);                                       // reports and layouts
  },
  'launch-2026': async (c) => {
    await c.query(`INSERT INTO "SchoolSyncRun" ("id", "datasetKey", "normaliserVersion", "dataSourceId", "datasetLabel", "fileName",
      "fileSha256", "format", "rowCount", "reconciliation", "counts", "reportDigest", "decisionsDigest", "comparedAt", "expiresAt", "mode")
      SELECT 'rel-run-new-only', 'rehearsal', '1', "id", 'Rehearsal', 'r.csv', repeat('0', 64), 'csv', 0, '{}', '{}', 'd', 'd', '2026-12-06', '2026-12-07', 'NEW_ONLY'
        FROM "SchoolDataSource" ORDER BY "id" LIMIT 1`);                                                                             // sync modes
    await c.query(`INSERT INTO "TeacherApplication" ("id", "firstName", "lastName", "username", "email", "phone", "country", "schoolProvince",
      "schoolDistrict", "homeDistrict", "homeSector", "updatedAt", "proposedSchoolName", "proposedSchoolCode")
      VALUES ('rel-ta-1', 'Teacher', 'Applicant', 'rel-teacher', 'rel-teacher@example.invalid', '+250700000003', 'RW', 'Kigali', 'Gasabo',
        'Gasabo', 'Remera', '2026-12-06', 'Rehearsal Unlisted School', '999999')`);                                                // unlisted-school details
    await c.query(`INSERT INTO "RegistrationSavedFilter" ("id", "ownerId", "name", "category", "filter", "columns", "sort", "updatedAt")
      VALUES ('rel-rsf-1', 'pre-user-3', 'Rehearsal filter', 'STUDENT', '{}', '[]', '[]', '2026-12-06')`);                         // saved filters
    await c.query(`INSERT INTO "CoachProgrammeRestriction" ("id", "coachId", "disciplineId", "capability", "reason", "createdAt")
      SELECT 'rel-cpr-1', 'pre-user-1', "id", 'STUDENTS', 'Restricted for the rehearsal', '2026-12-06' FROM "Discipline" ORDER BY "id" LIMIT 1`); // coach restrictions
    await c.query(`UPDATE "FormAvailability" SET "requireEmailVerification" = true WHERE "key" = (SELECT "key" FROM "FormAvailability" ORDER BY "key" LIMIT 1)`); // activation per form
    await c.query(`INSERT INTO "Subscriber" ("id", "email", "source", "updatedAt", "subscribedAt", "createdAt")
      VALUES ('rel-subscriber-1', 'reader@example.invalid', 'WEBSITE', '2026-12-06', '2026-12-06', '2026-12-06')`);              // subscribers
    await c.query(`INSERT INTO "ViewAsSession" ("id", "actorId", "targetId", "reason", "ticketExpiresAt", "createdAt")
      VALUES ('rel-view-as-1', 'pre-user-3', 'pre-user-2', 'Checking what the coach sees', '2026-12-06', '2026-12-06')`);         // view-as sessions
  },
  'email-2026': async (c) => {
    await c.query(`INSERT INTO "EmailDelivery" ("id", "recipientEmail", "subject", "status", "errorMessage", "kind", "priority")
      VALUES ('rel-mail-discarded', 'gone@example.invalid', 'Reset your password', 'DISCARDED', 'Not sent: the link expired.', 'PASSWORD_RESET', 'CRITICAL')`);
    await c.query(`INSERT INTO "EmailDelivery" ("id", "recipientEmail", "subject", "body", "kind", "priority")
      VALUES ('rel-mail-waiting', 'wait@example.invalid', 'Welcome', 'Hello', 'WELCOME', 'NORMAL')`);                             // budget data
    await c.query(`INSERT INTO "EmailSendingState" ("key", "pausedUntil", "pauseReason", "updatedAt")
      VALUES ('provider', '2026-12-31', 'DAILY_QUOTA', '2026-12-31')`);                                                           // provider pause
  },
};

/** A test and one submission to it (release-time rows "rel-…"): the Test Management guards need them. */
async function seedTestAndSubmission(c: Client) {
  await c.query(`INSERT INTO "Test" ("id", "title", "disciplineId", "answerFormat", "opensAt", "closesAt", "originalClosesAt", "maxMarks", "updatedAt")
    SELECT 'rel-test-1', 'Rehearsal test', "id", (enum_range(NULL::"TestAnswerFormat"))[1], '2026-12-01', '2026-12-02', '2026-12-02', 10, '2026-12-01'
      FROM "Discipline" ORDER BY "id" LIMIT 1`);
  await c.query(`INSERT INTO "TestSubmission" ("id", "testId", "studentId", "publicCode", "updatedAt")
    VALUES ('rel-sub-1', 'rel-test-1', 'pre-user-2', 'REL-0001', '2026-12-02')`);
}

const RELEASES = ['phase1', 'post-phase1', 'areas-2026', 'late-2026', 'dec-2026', 'levels-2026', 'launch-2026', 'email-2026'];

// ── Pure checks: object lists against the SQL, the acknowledgement allow-list, PG_BIN ───────────────────────────────

describe('release kit: object lists, acknowledgements and PG_BIN (no database)', () => {
  it('every object each migration SQL names is in its object list (or covered by a table it creates, or deliberately kept)', () => {
    for (const [m, o] of Object.entries(rel.MIGRATION_OBJECTS) as [string, Any][]) {
      if (!allDirs.includes(m)) continue;
      const sql = readFileSync(join(ROOT, 'prisma/migrations', m, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
      const cr = o.creates ?? {};
      const tables = new Set<string>(cr.tables ?? []);
      const has = (list: Any[] | undefined, pair: string[]) => (list ?? []).some((x: string[]) => x[0] === pair[0] && x[1] === pair[1]);
      const missing: string[] = [];
      for (const [, t] of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"/g)) if (!tables.has(t)) missing.push(`table ${t}`);
      for (const [, e] of sql.matchAll(/CREATE TYPE "(\w+)"/g)) if (!(cr.enums ?? []).includes(e)) missing.push(`enum ${e}`);
      for (const [, e, v] of sql.matchAll(/ALTER TYPE "(\w+)" ADD VALUE (?:IF NOT EXISTS )?'(\w+)'/g)) {
        if (!has(cr.enumValues, [e, v]) && !has(o.kept?.enumValues, [e, v])) missing.push(`enum value ${e}.${v}`);
      }
      for (const [, i, t] of sql.matchAll(/CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"(\w+)" ON "(\w+)"/g)) if (!tables.has(t) && !has(cr.indexes, [t, i])) missing.push(`index ${t}.${i}`);
      for (const [, g, t] of sql.matchAll(/CREATE (?:OR REPLACE )?TRIGGER (\w+)[\s\S]*? ON "(\w+)"/g)) if (!tables.has(t) && !has(cr.triggers, [t, g])) missing.push(`trigger ${t}.${g}`);
      for (const [, f] of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:"?public"?\.)?"?(\w+)"?\s*\(/g)) {
        // A function the migration only REPLACES (created by an earlier migration) is not its object.
        const earlier = Object.entries(rel.MIGRATION_OBJECTS).some(([n, x]: [string, Any]) => n < m && (x.creates?.functions ?? []).includes(f));
        if (!earlier && !(cr.functions ?? []).includes(f)) missing.push(`function ${f}`);
      }
      for (const [, i] of sql.matchAll(/DROP INDEX (?:IF EXISTS )?"(\w+)"/g)) if (!(o.drops?.indexes ?? []).some((x: string[]) => x[1] === i)) missing.push(`dropped index ${i}`);
      // Columns and constraints added to an existing table (ALTER TABLE "T" … ADD COLUMN / ADD CONSTRAINT, over several lines).
      for (const [, t, body] of sql.matchAll(/ALTER TABLE (?:ONLY )?"(\w+)"([^;]*);/g)) {
        if (tables.has(t)) continue;
        for (const [, col] of body.matchAll(/ADD COLUMN (?:IF NOT EXISTS )?"(\w+)"/g)) if (!has(cr.columns, [t, col])) missing.push(`column ${t}.${col}`);
        for (const [, con] of body.matchAll(/ADD CONSTRAINT "(\w+)"/g)) if (!has(cr.constraints, [t, con])) missing.push(`constraint ${t}.${con}`);
      }
      expect({ migration: m, missing }).toEqual({ migration: m, missing: [] });
    }
  });

  it('the acknowledgement allow-list is exactly the guards written in the rollback files', () => {
    for (const name of RELEASES) {
      const release = rel.releaseFrom(['--release', name]);
      if (!release || !release.migrations.every((m: string) => allDirs.includes(m))) continue;
      const fromFiles = kit.guardsInFiles(release);
      const allowed = rel.releaseAcknowledgements(release).map((id: string) => ({ migration: rel.ACKNOWLEDGEMENTS[id].migration,
        setting: rel.ACKNOWLEDGEMENTS[id].setting, value: rel.ACKNOWLEDGEMENTS[id].value }));
      expect(allowed.sort((a: Any, b: Any) => a.setting.localeCompare(b.setting))).toEqual(fromFiles);
      expect(fromFiles.length).toBeGreaterThan(0);
    }
  });

  it('--acknowledge: only ids of the release allow-list; unknown, malformed, duplicate or another release\'s ids are refused', () => {
    const post = rel.releaseFrom(['--release', 'post-phase1']);
    const ok = rel.resolveAcknowledgements(['registration-details', 'teacher-student-access'], post);
    expect(ok).toEqual({ ok: true, acks: [
      { id: 'registration-details', setting: 'rof.registration_details_rollback', value: 'discard-registration-details' },
      { id: 'teacher-student-access', setting: 'rof.teacher_student_rollback', value: 'discard-teacher-student-access' }] });
    expect(rel.resolveAcknowledgements([], post)).toEqual({ ok: true, acks: [] });
    const refused = (values: string[], re: RegExp) => {
      const r = rel.resolveAcknowledgements(values, post);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(re);
    };
    refused(['everything'], /not a guard of post-phase1/);
    refused(['registration-detail'], /not a guard/);
    refused(['country-edits'], /not a guard of post-phase1/);                                        // areas-2026's
    refused(['directory-data'], /not a guard of post-phase1/);                                       // phase1's
    refused(['rof.registration_details_rollback'], /malformed/);                                     // setting names are not ids
    refused(['rof.registration_details_rollback=discard-registration-details'], /malformed/);
    refused(['Registration-Details'], /malformed/);
    refused([''], /malformed/);
    refused(['registration-details;DROP TABLE x'], /malformed/);
    refused(['registration-details', 'registration-details'], /given twice/);
    expect(kit.optionValues(['rollback', '--acknowledge', 'a', '--confirm', 'ep', '--acknowledge=b', '--acknowledge'], '--acknowledge')).toEqual(['a', 'b', '']);
  });

  it('PG_BIN: an absolute existing folder with pg_dump and pg_restore of one major version, at least the server\'s; clear Windows instructions otherwise', () => {
    const bin = 'C:\\Program Files\\PostgreSQL\\18\\bin';
    const files = new Set([join(bin, 'pg_dump.exe'), join(bin, 'pg_restore.exe')]);
    const run = (major: Record<string, number | null>) => (cmd: string) => {
      const name = /pg_restore/.test(cmd) ? 'pg_restore' : 'pg_dump';
      return major[name] === null ? { status: null, error: new Error('ENOENT') } : { status: 0, stdout: `${name} (PostgreSQL) ${major[name]}.1\n` };
    };
    const win = (env: Record<string, string>, major: Record<string, number | null> = { pg_dump: 18, pg_restore: 18 }, dirs = [bin]) =>
      kit.findPgTools({ env, platform: 'win32', run: run(major), isDir: (p: string) => dirs.includes(p), isFile: (p: string) => files.has(p) });
    const ok = win({ PG_BIN: bin });
    expect(ok).toMatchObject({ ok: true, dir: bin, dump: { bin: join(bin, 'pg_dump.exe'), major: 18 }, restore: { major: 18 } });
    expect(win({ PG_BIN: `"${bin}"` }).ok).toBe(true);                                                // pasted with quotes
    const reason = (r: Any) => { expect(r.ok).toBe(false); return r.reason as string; };
    expect(reason(win({ PG_BIN: 'PostgreSQL\\18\\bin' }))).toMatch(/must be the absolute path/);
    expect(reason(win({ PG_BIN: 'C:\\Program Files\\PostgreSQL\\17\\bin' }))).toMatch(/does not exist/);
    expect(reason(win({ PG_BIN: 'C:\\tools' }, undefined, ['C:\\tools']))).toMatch(/has no pg_dump\.exe/);
    expect(reason(win({ PG_BIN: bin }, { pg_dump: 18, pg_restore: 17 }))).toMatch(/different PostgreSQL versions/);
    expect(reason(win({ PG_BIN: bin }, { pg_dump: null, pg_restore: 18 }))).toMatch(/could not be run/);
    const notFound = reason(win({}, { pg_dump: null, pg_restore: null }));
    expect(notFound).toMatch(/not found on PATH and PG_BIN is not set/);
    expect(notFound).toContain('$env:PG_BIN = "C:\\Program Files\\PostgreSQL\\18\\bin"');
    expect(notFound).toContain('export PG_BIN="C:/Program Files/PostgreSQL/18/bin"');
    expect(notFound).toMatch(/add that folder to PATH/);
    expect(win({}).ok).toBe(true);                                                                     // on PATH
    expect(kit.pgToolsProblem(ok, 18)).toBeNull();
    expect(kit.pgToolsProblem(ok, 17)).toBeNull();
    expect(kit.pgToolsProblem({ ...ok, dump: { major: 16 }, restore: { major: 16 } }, 18)).toMatch(/older than the server \(PostgreSQL 18\)/);
  });

  it('a newer checkout: the release-only commands accept it, deploy / diff / status keep the strict rule', () => {
    const post = rel.releaseFrom(['--release', 'post-phase1']);
    const dirs = [...allDirs.filter((d) => d.slice(0, 14) <= post.last), '20261299000000_later'];
    expect(rel.checkoutProblem(post, dirs)).toMatch(/after post-Phase-1/);
    expect(rel.checkoutProblem(post, dirs, { allowLater: true })).toBeNull();
    expect(rel.checkoutProblem(post, dirs.filter((d) => d !== '20261204000000_registration_details'), { allowLater: true })).toMatch(/found 10/);
    expect([...kit.CHECKOUT_RELEASE_ONLY].sort()).toEqual(['check-target', 'dump', 'postcheck', 'precheck', 'restore', 'rollback', 'rollback-history']);
  });
});

// ── Against a real database, per release ────────────────────────────────────────────────────────────────────────────

for (const name of RELEASES) {
  describe(`release kit: ${name} rollback, interrupted and resumed (real PostgreSQL)`, () => {
    let release: Any;
    let skip = false;
    let pre = '';        // migrated to just before the release, seeded
    let tpl = '';        // the release applied and seeded (the template of every scenario)
    let preRows: Map<string, string>;
    let preSchema: string[];
    let relSchema: string[];
    let reference: { schema: string[]; data: Record<string, string[]> };
    let cleanRan: string[] = [];
    let allAcks: Any[] = [];
    const logs: string[] = [];
    const quiet = { log: (l: string) => logs.push(l), table: () => undefined };
    const ids = () => rel.releaseAcknowledgements(release) as string[];
    const acksExcept = (...ex: string[]) => rel.resolveAcknowledgements(ids().filter((i) => !ex.includes(i)), release).acks;
    const guardOf = (file: string) => ids().find((i) => rel.ACKNOWLEDGEMENTS[i].migration === kit.migrationOfFile(file));
    /** A check-only migration's file (it changes nothing): it runs every time the rollback reaches it, never "already rolled back". */
    const isCheckOnly = (file: string) => Boolean(rel.MIGRATION_OBJECTS[kit.migrationOfFile(file)].checkOnly);
    const rollback = (db_: string, opts: Any = {}) => kit.rollbackRelease(url(db_), release, { ...quiet, ...opts });
    const history = (db_: string) => (release.name === 'phase1' ? kit.rollbackHistoryPhase1 : kit.rollbackHistoryRelease)(url(db_), release, { log: quiet.log, error: quiet.log, root: ROOT });
    const statesOf = (db_: string): Promise<Any[]> => withDb(db_, (c) => kit.migrationStates(c, release));

    /** After a complete rollback: equals the reference, rollback-history works (twice), re-applying gives the release schema. */
    async function expectCompleteAndReapply(db_: string) {
      const s = await state(db_);
      expect(s.schema).toEqual(reference.schema);
      expect(s.data).toEqual(reference.data);
      expect(await history(db_)).toBe(0);
      expect(await history(db_)).toBe(0);
      expect(logs.at(-1)).toBe('deleted 0 history row(s): none');
      const left = (await withDb(db_, (c) => c.query('SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = ANY($1)', [release.migrations]))).rows;
      expect(left).toEqual([]);
      await withDb(db_, async (c) => { for (const m of release.migrations) await db.applyMigration(c, ROOT, m); });
      expect(await withDb(db_, schemaOf)).toEqual(relSchema);
    }

    beforeAll(async () => {
      release = rel.releaseFrom(['--release', name]);
      // A release this checkout does not define or hold (e.g. areas-2026 on a post-Phase-1 release branch) is skipped.
      skip = !release || !release.migrations.every((m: string) => allDirs.includes(m));
      if (skip) return;
      const first = [...release.migrations].sort()[0];
      pre = await newDb(`${name.replace(/\W/g, '')}_pre`);
      await withDb(pre, async (c) => {
        for (const m of allDirs.filter((d) => d < first)) await db.applyMigration(c, ROOT, m);
        await seedPre(c);
        preRows = await rowsByKey(c);
        preSchema = await schemaOf(c);
      });
      tpl = await newDb(`${name.replace(/\W/g, '')}_tpl`, pre);
      await withDb(tpl, async (c) => {
        let before = await cat.catalogLabels(c);
        for (const m of [...release.migrations].sort()) {
          await db.applyMigration(c, ROOT, m);
          const after = await cat.catalogLabels(c);
          // The object list equals what the migration's SQL changed in the catalogue (kept objects aside).
          const o = rel.MIGRATION_OBJECTS[m];
          const derived = cat.objectsFromCatalog(before, after);
          const kept = o.kept?.enumValues ?? [];
          if (derived.creates.enumValues) {
            derived.creates.enumValues = derived.creates.enumValues.filter(([e, v]: string[]) => !kept.some((k: string[]) => k[0] === e && k[1] === v));
            if (!derived.creates.enumValues.length) delete derived.creates.enumValues;
          }
          expect({ m, creates: derived.creates, drops: derived.drops }).toEqual({ m, creates: o.creates ?? {}, drops: o.drops ?? {} });
          before = after;
        }
        await SEEDS[name](c);
        relSchema = await schemaOf(c);
      });
      allAcks = acksExcept();
      // The reference: a clean full rollback with every acknowledgement.
      const clean = await newDb(`${name.replace(/\W/g, '')}_clean`, tpl);
      const r = await rollback(clean, { acknowledgements: allAcks });
      expect(r).toMatchObject({ stopped: false, skipped: [] });
      cleanRan = r.ran;
      reference = await state(clean);
    }, 600_000);

    it('every guard refuses on the seeded release without its acknowledgement, and nothing changes', async () => {
      if (skip) return;
      const files = kit.releaseFiles(release, readdirSync(join(ROOT, 'docs/migrations')));
      expect(cleanRan).toEqual([...files.preSwitch, ...files.rollback]);
      for (const id of ids()) {
        const d = await newDb('guard', tpl);
        const file = cleanRan.find((f) => f.endsWith('.rollback.sql') && kit.migrationOfFile(f) === rel.ACKNOWLEDGEMENTS[id].migration) as string;
        // Only this file's acknowledgement is missing; the newer files are rolled back first (as on staging).
        await expect(rollback(d, { acknowledgements: acksExcept(id) })).rejects.toThrow(new RegExp(`${file.replace(/\./g, '\\.')}: .*_REFUSED`));
        const states = await statesOf(d);
        expect(states.find((s: Any) => s.migration === kit.migrationOfFile(file)).state).toBe('present');
        const before = await state(d);
        // The staging case: run again, nothing acknowledged differently → the same guard refuses (no "does not exist"), nothing changes.
        logs.length = 0;
        await expect(rollback(d, { acknowledgements: acksExcept(id) })).rejects.toThrow(/_REFUSED/);
        expect(logs.join('\n')).not.toMatch(/does not exist/);
        expect(logs.filter((l) => l.includes('already rolled back')).length)
          .toBe(cleanRan.slice(0, cleanRan.indexOf(file)).filter((f) => kit.migrationOfFile(f) !== kit.migrationOfFile(file) && !isCheckOnly(f)).length);
        expect(await state(d)).toEqual(before);
        // With a DIFFERENT acknowledgement only: still refused, nothing changes.
        const other = ids().find((i) => i !== id);
        if (other) {
          await expect(rollback(d, { acknowledgements: rel.resolveAcknowledgements([other], release).acks })).rejects.toThrow(/_REFUSED/);
          expect(await state(d)).toEqual(before);
        }
        // Acknowledged through PGOPTIONS (libpq's -c), as on staging: completes and equals the clean rollback.
        const setting = rel.ACKNOWLEDGEMENTS[id];
        process.env.PGOPTIONS = `-c ${setting.setting}=${setting.value}`;
        try {
          logs.length = 0;
          await rollback(d, { acknowledgements: acksExcept(id) });
          expect(logs).toContain(`acknowledgement: ${setting.setting} = '${setting.value}' (PGOPTIONS or a role/database setting) — that guard will let the data it protects be DISCARDED`);
        } finally {
          delete process.env.PGOPTIONS;
        }
        await expectCompleteAndReapply(d);
        await drop(d);
      }
    }, 900_000);

    it('interrupted after file k, for every k: guards still refuse and change nothing; resumed, it equals the clean rollback', async () => {
      if (skip) return;
      for (let k = 1; k < cleanRan.length; k++) {
        const d = await newDb('stop', tpl);
        const first = await rollback(d, { acknowledgements: allAcks, stopAfter: k });
        expect(first).toMatchObject({ ran: cleanRan.slice(0, k), stopped: true });
        // Not complete: rollback-history refuses and changes nothing (Phase 1's only concerns M9–M14, whose rows it deletes;
        // M1–M8 delete their own row in their rollback file).
        const atStop = await state(d);
        const objectBased = (await statesOf(d)).filter((x) => !rel.MIGRATION_OBJECTS[x.migration].history && !x.checkOnly);
        if (objectBased.some((x) => x.state !== 'absent')) {
          expect(await history(d)).toBe(1);
          expect(await state(d)).toEqual(atStop);
        }
        // Without acknowledgements: the next guarded file refuses; if it is the next file to run, nothing changes at all.
        // The files still to run: those after the stop, and the check-only ones before it (they run every time).
        const rest = cleanRan.filter((f, i) => i >= k || isCheckOnly(f));
        const guarded = rest.findIndex((f) => f.endsWith('.rollback.sql') && guardOf(f));
        if (guarded >= 0) {
          const file = rest[guarded];
          await expect(rollback(d)).rejects.toThrow(new RegExp(`${file.replace(/\./g, '\\.')}: .*_REFUSED`));
          const st = (await statesOf(d)).find((s: Any) => s.migration === kit.migrationOfFile(file));
          expect(st.state).toBe('present');
          if (guarded === 0) expect(await state(d)).toEqual(atStop);
          const other = ids().find((i) => i !== guardOf(file));
          if (other) {
            const mid = await state(d);
            await expect(rollback(d, { acknowledgements: rel.resolveAcknowledgements([other], release).acks })).rejects.toThrow(/_REFUSED/);
            expect(await state(d)).toEqual(mid);
          }
        }
        // Resumed with every acknowledgement: completes; the files already run are skipped, never run twice (a check-only
        // file changes nothing and runs again).
        logs.length = 0;
        const second = await rollback(d, { acknowledgements: allAcks });
        expect(second.stopped).toBe(false);
        expect([...second.skipped, ...second.ran].sort()).toEqual([...cleanRan].sort());
        for (const f of cleanRan.slice(0, k)) if (f.endsWith('.rollback.sql') && !isCheckOnly(f)) expect(second.skipped).toContain(f);
        for (const f of cleanRan.filter(isCheckOnly)) expect(second.ran).toContain(f);
        await expectCompleteAndReapply(d);
        await drop(d);
      }
    }, 1_800_000);

    it('the clean rollback removes every object of the release and keeps every row that existed before it', async () => {
      if (skip) return;
      const d = await newDb('full', tpl);
      await rollback(d, { acknowledgements: allAcks });
      // Schema: exactly as before the release, except what the rollback files deliberately keep (an enum value).
      const kept = release.migrations.flatMap((m: string) => rel.MIGRATION_OBJECTS[m].kept?.enumValues ?? []);
      const strip = (lines: string[]) => lines.map((l) => kept.reduce((acc: string, [e, v]: string[]) => (acc.startsWith(`enum ${e} `) ? acc.replace(new RegExp(`,${v}\\b`), '') : acc), l));
      expect(strip(await withDb(d, schemaOf))).toEqual(preSchema);
      for (const s of await statesOf(d)) if (!s.checkOnly) expect(s.state).toBe('absent');   // a check-only migration has no state
      // Data: every pre-release row is still there, unchanged; the only new rows are release-time ones, audit rows (append
      // only) and the registration switches written back by the form-availability rollback.
      const after = await withDb(d, rowsByKey);
      const changed = [...preRows].filter(([k, h]) => after.get(k) !== h).map(([k]) => k);
      expect(changed).toEqual([]);
      const added = [...after.keys()].filter((k) => !preRows.has(k) && !k.startsWith('AuditLog ') && !k.includes('"rel-') && !k.startsWith('SystemSetting ["registration.'));
      expect(added).toEqual([]);
      // Run again on the rolled-back database: everything is skipped but the check-only files (which change nothing, and
      // whose guards still need their acknowledgement), nothing changes.
      const before = await state(d);
      const checkOnly = cleanRan.filter((f) => rel.MIGRATION_OBJECTS[kit.migrationOfFile(f)].checkOnly);
      const again = await rollback(d, checkOnly.length ? { acknowledgements: allAcks } : {});
      expect(again).toMatchObject({ ran: checkOnly, stopped: false });
      expect(again.skipped.length).toBe(cleanRan.length - checkOnly.length);
      expect(await state(d)).toEqual(before);
    }, 300_000);

    it('half rolled back or out of order: refused before anything runs, naming what remains; nothing changes', async () => {
      if (skip) return;
      const cases: Record<string, [string, string, RegExp][]> = {
        phase1: [
          ['an added column dropped by hand', 'ALTER TABLE "SchoolSyncRun" DROP COLUMN "approvedGeneration"', /20261121001300_school_directory_sync_approval: still there: .*column SchoolSyncRun\.approvedAt.*already gone: column SchoolSyncRun\.approvedGeneration/],
          ['a table dropped, its enums left', 'DROP TABLE "StudentSchoolAffiliation" CASCADE', /20261121000800_student_school_affiliation: still there: enum SchoolAffiliationSource/],
          ['out of order', 'ALTER TABLE "School" DROP COLUMN "countryCode", DROP COLUMN "createdById", DROP COLUMN "isActive", DROP COLUMN "source", DROP COLUMN "updatedAt"; DROP TYPE "SchoolSource"', /20261121001000_school_administration is already rolled back while the newer 20261121001300_school_directory_sync_approval is not/],
        ],
        'post-phase1': [
          ['a table dropped but its column left', 'DROP TABLE "NotificationOutbox"', /20261202000000_notification_outbox: still there: .*column TeacherApplication\.schoolVerifiedAt.*already gone: table NotificationOutbox/],
          ['a table dropped but its trigger left', 'DROP TABLE "UserStatusChange"', /20261206000000_account_states: still there: .*trigger User\.user_account_status_sync.*already gone: table UserStatusChange/],
          ['the tables dropped, an index left', 'DROP TABLE "BulkOperationItem"; DROP TABLE "BulkOperation"; DROP TYPE "BulkItemOutcome"; DROP TYPE "BulkOperationStatus"; DROP INDEX "User_createdAt_idx"',
            /20261207000000_bulk_operations: still there: index User\.User_gradeLevel_idx; already gone: .*table BulkOperation/],
          ['the staging tables dropped, the rest left', 'DROP TABLE "UserPermissionOverrideStudent"; DROP TABLE "TeacherStudentAssignment"', /20261210000000_teacher_student_access: still there: .*column UserPermissionOverride\.studentScope/],
          ['a replaced index restored by hand', 'CREATE UNIQUE INDEX "MentorRequest_username_key" ON "MentorRequest"("username")', /20261209000000_application_details: still there: .*already gone: index MentorRequest\.MentorRequest_username_key still dropped/],
          ['out of order', 'ALTER TABLE "User" DROP COLUMN "olympiadInterests"', /20261203000000_student_olympiad_interests is already rolled back while the newer 20261210000000_teacher_student_access is not/],
        ],
        'areas-2026': [
          ['an index dropped by hand', 'DROP INDEX "TeacherSchoolAssignment_one_primary_per_school"', /20261212000000_teacher_school_primary: still there: .*column TeacherSchoolAssignment\.role.*already gone: index TeacherSchoolAssignment\.TeacherSchoolAssignment_one_primary_per_school/],
          ['a table dropped, its column left', 'DROP TABLE "TestResultWithdrawal"', /20261220000400_tests_publishing: still there: .*column Test\.studentRankingsVisible.*already gone: table TestResultWithdrawal/],
          // The Test Management migrations come after the primary teacher's: the newest one still in place is tests_publishing.
          ['out of order', 'ALTER TABLE "School" DROP CONSTRAINT "School_countryCode_fkey"; DROP TABLE "Country"', /20261211000000_countries_reference is already rolled back while the newer 20261220000400_tests_publishing is not/],
        ],
        'late-2026': [
          ['a column dropped by hand', 'ALTER TABLE "MentorRequest" DROP COLUMN "homeSector"', /20261221000100_home_location: still there: .*column MentorRequest\.homeDistrict.*already gone: column MentorRequest\.homeSector/],
          ['out of order', 'ALTER TABLE "User" DROP COLUMN "gender"; ALTER TABLE "MentorRequest" DROP COLUMN "gender"; ALTER TABLE "TeacherApplication" DROP COLUMN "gender"; DROP TYPE "Gender"',
            /20261221000000_registration_gender is already rolled back while the newer 20261222000000_bulk_operations_generic is not/],
        ],
        'dec-2026': [
          ['a constraint dropped by hand', 'ALTER TABLE "User" DROP CONSTRAINT "User_olympiadInterestOther_length"', /20261223000000_olympiad_interest_other: still there: .*already gone: constraint User\.User_olympiadInterestOther_length/],
          ['out of order', 'ALTER TABLE "User" DROP COLUMN "olympiadInterestOther"; ALTER TABLE "MentorRequest" DROP COLUMN "olympiadInterestOther"; ALTER TABLE "TeacherApplication" DROP COLUMN "olympiadInterestOther"',
            /20261223000000_olympiad_interest_other is already rolled back while the newer 20261223000100_test_resubmission_lock is not/],
        ],
        'levels-2026': [
          ['the report tables dropped, the rest left', 'DROP TABLE "CustomReportGrant"; DROP TABLE "CustomReport"', /20261224000000_divisions_levels: still there: .*table DivisionChange.*already gone: table CustomReport, table CustomReportGrant/],
          ['a dropped enum created again by hand', `CREATE TYPE "DivisionCode" AS ENUM ('JUNIOR', 'SENIOR')`, /20261224000000_divisions_levels: still there: .*already gone: enum DivisionCode still dropped/],
        ],
        'launch-2026': [
          ['a table dropped, its column left', 'DROP TABLE "RegistrationSavedFilter"', /20261226000000_registration_data: still there: column MentorRequest\.userId.*already gone: table RegistrationSavedFilter/],
          ['the subscriber tables dropped, the column left', 'ALTER TABLE "EmailDelivery" DROP CONSTRAINT "EmailDelivery_subscriberId_fkey"; DROP TABLE "Mailing"; DROP TABLE "Subscriber"',
            /20261229000000_subscribers: still there: .*column EmailDelivery\.subscriberId.*already gone: .*table Mailing/],
          ['out of order', 'ALTER TABLE "SchoolSyncRun" DROP COLUMN "mode"; DROP TYPE "SchoolSyncMode"', /20261225000000_school_sync_mode is already rolled back while the newer 20261230000000_view_as is not/],
        ],
        'email-2026': [
          ['the table dropped, the columns left', 'DROP TABLE "EmailSendingState"', /20261231000000_email_free_plan: still there: .*column EmailDelivery\.kind.*already gone: table EmailSendingState/],
          ['an index dropped by hand', 'DROP INDEX "NotificationOutbox_status_sentAt_idx"', /20261231000000_email_free_plan: still there: .*already gone: index NotificationOutbox\.NotificationOutbox_status_sentAt_idx/],
        ],
      };
      for (const [label, sql, message] of cases[name]) {
        const d = await newDb('half', tpl);
        await withDb(d, (c) => c.query(sql));
        const before = await state(d);
        const err = await rollback(d, { acknowledgements: allAcks }).then(() => null, (e: Error) => e);
        expect(err, label).toBeInstanceOf(Error);
        expect((err as Error).message, label).toMatch(/^refused: /);
        expect((err as Error).message, label).toMatch(message);
        expect((err as Error).message, label).toMatch(/Nothing was changed/);
        expect(await state(d), label).toEqual(before);
        expect(await history(d), label).toBe(1);
        await drop(d);
      }
    }, 300_000);
  });
}
