/**
 * Release kit, question-marking-2027 (design Rev 5.2 §10 and addendum 5.1 point 6), against a real PostgreSQL:
 *  - precheck on the state before the release (production after banking-2026): its MUST lines hold;
 *  - both migrations applied; postcheck: tables empty, COMPOSED present and unused, every test PAPER, 19 triggers,
 *    4 functions, no projection mismatch; the compared counts equal the precheck's;
 *  - rollback level 2 guard (code-rollback-check): 0 before question data, refuses (1) once a QUESTION test has tasks;
 *  - rollback level 3 with question data: refused without evidence; a backup restored into a SEPARATE scratch database
 *    and checksummed gives a manifest; a row written after the backup makes the same manifest stale (refused, nothing
 *    changed); a fresh manifest lets it through; the schema then equals the state before the release and every row that
 *    existed before the release is unchanged; rollback-history removes both history rows; re-applying both migrations
 *    gives the release schema again (ADD VALUE IF NOT EXISTS is a no-op);
 *  - a COMPOSED final marking: refused whatever the evidence (roll forward).
 * Real pg_dump / pg_restore are exercised by the local rehearsal (report); here the "dump" is a database template copy, so
 * the test runs wherever the e2e job runs. Databases are rk_* next to TEST_DATABASE_URL and dropped afterwards.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Client } from 'pg';

const ROOT = join(__dirname, '..');
type Any = any;
const load = (p: string): Promise<Any> => import(/* @vite-ignore */ pathToFileURL(join(ROOT, p)).href);
const ADMIN = process.env.TEST_DATABASE_URL as string;
const QM = ['20270101000000_question_marking_kind', '20270101000100_question_marking'];
const QM_TABLES = ['TestQuestionMarker', 'TestQuestionTask', 'TestTaskClaim', 'TestQuestionAssessment', 'TestAssessmentVersion', 'TestMarkDraftChange',
  'TestQuestionDecision', 'TestTaskEvent', 'TestPaperAccess', 'TestStaffPaperAccess', 'TestQuestionPromptHistory'];

let kit: Any;
let rel: Any;
let db: Any;
let release: Any;
const created: string[] = [];
const dirs: string[] = [];
let pre: string;      // before the release, seeded
let post: string;     // both migrations applied
let seeded: string;   // with question-marking data
let preState: { schema: string[]; data: Record<string, string[]> };
let postSchema: string[];
let preCompare: Any[][];

const url = (name: string) => db.databaseUrl(ADMIN, name);
const withDb = <T>(name: string, fn: (c: Client) => Promise<T>): Promise<T> => db.withClient(url(name), fn);
async function newDb(prefix: string, template?: string) {
  const name = db.randomName(prefix);
  created.push(name);
  await db.createDatabase(ADMIN, name, template);
  return name;
}

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

async function dataOf(c: Client): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const tables = (await c.query(`SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND relname <> '_prisma_migrations' ORDER BY 1`)).rows;
  for (const { relname: t } of tables) out[t] = (await c.query(`SELECT md5(to_jsonb(x)::text) AS h FROM "${t}" x`)).rows.map((r) => r.h).sort();
  out._history = (await c.query('SELECT migration_name FROM "_prisma_migrations" ORDER BY 1')).rows.map((r) => r.migration_name);
  return out;
}
const state = (name: string) => withDb(name, async (c) => ({ schema: await schemaOf(c), data: await dataOf(c) }));

/** Runs a release SQL file read only (split by the kit's own `segments`) and returns every result set, empty ones included. */
async function sqlFile(name: string, file: string): Promise<Any[][]> {
  return withDb(name, async (c) => {
    await c.query('SET default_transaction_read_only = on');
    const sets: Any[][] = [];
    for (const seg of kit.segments(readFileSync(join(ROOT, file), 'utf8'))) {
      if (typeof seg === 'object') continue;
      const res = await c.query(seg);
      for (const r of [res].flat()) if (r.command === 'SELECT') sets.push(r.rows);
    }
    return sets;
  });
}
const num = (rows: Any[]) => Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));

/** Rows before the release: users, a PAPER test with a paper, a test that will be question-marked, with two questions and a paper. */
async function seedPre(c: Client) {
  for (const [id, role] of [['rq-coach', 'MENTOR'], ['rq-student', 'MENTOR'], ['rq-admin', 'ADMIN']]) {
    await c.query(`INSERT INTO "User" ("id", "firstName", "lastName", "username", "email", "role", "updatedAt")
      VALUES ($1, 'Rehearsal', $1, $1, $1 || '@example.invalid', $2, '2026-01-01')`, [id, role]);
  }
  for (const [test, sub] of [['rq-paper-test', 'rq-paper-sub'], ['rq-q-test', 'rq-q-sub']]) {
    await c.query(`INSERT INTO "Test" ("id", "title", "disciplineId", "answerFormat", "opensAt", "closesAt", "originalClosesAt", "maxMarks", "updatedAt")
      SELECT $1, 'Rehearsal ' || $1, "id", (enum_range(NULL::"TestAnswerFormat"))[1], '2026-12-01', '2026-12-02', '2026-12-02', 20, '2026-12-01'
        FROM "Discipline" ORDER BY "id" LIMIT 1`, [test]);
    for (const n of [1, 2]) {
      await c.query(`INSERT INTO "TestQuestion" ("id", "testId", "order", "prompt", "maxMarks", "updatedAt") VALUES ($1, $2, $3::int, 'Question ' || $3::text, 10, '2026-12-01')`,
        [`${test}-q${n}`, test, n]);
    }
    await c.query(`INSERT INTO "TestSubmission" ("id", "testId", "studentId", "publicCode", "updatedAt", "versionCount") VALUES ($1, $2, 'rq-student', upper($1), '2026-12-02', 1)`, [sub, test]);
    await c.query(`INSERT INTO "TestSubmissionVersion" ("id", "submissionId", "number", "clientKey", "submittedById", "submitterRole", "submittedAt", "applicableDeadline", "underExtension", "typedAnswer")
      VALUES ($1 || '-v1', $1, 1, $1, 'rq-student', 'STUDENT', '2026-12-02', '2026-12-02', false, 'Typed answer')`, [sub]);
    await c.query(`UPDATE "TestSubmission" SET "currentVersionId" = $1 || '-v1' WHERE "id" = $1`, [sub]);
  }
}

/** Question-marking data: the test switched to QUESTION, two tasks, their events (no approval, so no COMPOSED marking). */
async function seedQuestionWork(c: Client) {
  await c.query('BEGIN');
  await c.query(`UPDATE "Test" SET "markingMode" = 'QUESTION' WHERE "id" = 'rq-q-test'`);
  for (const n of [1, 2]) {
    await c.query(`INSERT INTO "TestQuestionTask" ("id", "submissionId", "questionId", "round", "versionId", "createdAt", "updatedAt")
      VALUES ($1, 'rq-q-sub', $2, 'FIRST', 'rq-q-sub-v1', '2026-12-03', '2026-12-03')`, [`rq-task-${n}`, `rq-q-test-q${n}`]);
    await c.query(`INSERT INTO "TestTaskEvent" ("id", "taskId", "action", "toStatus", "actorId", "actorRole", "createdAt")
      VALUES ($1, $2, 'TASK_CREATED', 'NOT_STARTED', 'rq-admin', 'ADMIN', '2026-12-03')`, [`rq-event-${n}`, `rq-task-${n}`]);
  }
  await c.query('COMMIT');
}

/**
 * The backup of a database: a template copy ("dump") and a file standing for it (its sha256 is what the manifest pins).
 * restoreFile restores the copy into the scratch database the kit checked was empty.
 */
async function backupOf(source: string) {
  const copy = await newDb('qm_dump', source);
  const dir = mkdtempSync(join(tmpdir(), 'rof-qm-backup-'));
  dirs.push(dir);
  const file = join(dir, `${copy}.dump`);
  writeFileSync(file, `rehearsal backup ${copy} ${Date.now()}\n`);
  const restoreFile = async (scratchUrl: string) => {
    const scratch = new URL(scratchUrl).pathname.slice(1);
    await db.dropDatabase(ADMIN, scratch);
    await db.createDatabase(ADMIN, scratch, copy);
  };
  return { file, restoreFile };
}

async function verified(source: string) {
  const backup = await backupOf(source);
  const scratch = await newDb('qm_scratch');
  const r = await kit.verifyBackup({ release, targetUrl: url(source), scratchUrl: url(scratch), dumpFile: backup.file, restoreFile: backup.restoreFile, log: () => undefined });
  return { ...r, evidence: kit.evidenceSetting(release, r.manifestFile) };
}

const quiet = { log: () => undefined, table: () => undefined };

beforeAll(async () => {
  [kit, rel, db] = await Promise.all([load('scripts/release/rehearsal.mjs'), load('scripts/release/releases.mjs'), load('test/support/release-db.mjs')]);
  release = rel.releaseFrom(['--release', 'question-marking-2027']);
  const all = rel.migrationDirs ? rel.migrationDirs(ROOT) : (await load('scripts/release/phase1.mjs')).migrationDirs(ROOT);
  pre = await newDb('qm_pre');
  await withDb(pre, async (c) => {
    for (const m of all.filter((d: string) => d < QM[0])) await db.applyMigration(c, ROOT, m);
    await seedPre(c);
  });
  preState = await state(pre);
  post = await newDb('qm_post', pre);
  await withDb(post, async (c) => { for (const m of QM) await db.applyMigration(c, ROOT, m); });
  postSchema = await withDb(post, schemaOf);
  seeded = await newDb('qm_seeded', post);
  await withDb(seeded, seedQuestionWork);
}, 600_000);

afterAll(async () => {
  for (const name of [...created].reverse()) await db.dropDatabase(ADMIN, name);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 600_000);

describe('question-marking-2027 release kit (real PostgreSQL)', () => {
  it('precheck before the release: banking applied, nothing of this release, no table, no COMPOSED', async () => {
    const sets = await sqlFile(pre, release.precheck);
    expect(num(sets[0])).toEqual({ banking_applied: 1, question_marking_or_later: 0, failed_or_rolled_back: 0 });
    expect(num(sets[1])).toEqual({ question_marking_tables: 0, composed_kind: 0 });
    preCompare = sets.slice(2, 5);
    expect(sets[5][0].assignment_matches_kind).toBe(`CHECK (((kind = 'ADJUSTMENT'::"TestMarkingKind") = ("assignmentId" IS NULL)))`);
  });

  it('postcheck after both migrations: 11 empty tables, COMPOSED unused, all PAPER, 19 triggers, 4 functions, counts unchanged, no mismatch', async () => {
    const sets = await sqlFile(post, release.postcheck);
    expect(num(sets[0])).toEqual({ question_marking_applied: 2, later: 0, failed_or_rolled_back: 0 });
    expect(num(sets[1])).toEqual({ question_marking_tables: 11, question_marking_rows: 0, composed_kind: 1, composed_markings: 0, question_mode_tests: 0 });
    expect(sets.slice(2, 5)).toEqual(preCompare);
    expect(num(sets[5])).toEqual({ question_marking_triggers: 19 });
    expect(num(sets[6])).toEqual({ question_marking_functions: 4 });
    expect(sets[7][0].assignment_matches_kind).toMatch(/ADJUSTMENT.*COMPOSED/);
    expect(num(sets[8])).toEqual({ projection_mismatches: 0 });
    // The seeded copy: still no mismatch between each QUESTION paper and its projection.
    expect(num((await sqlFile(seeded, release.postcheck))[8])).toEqual({ projection_mismatches: 0 });
  });

  it('rollback level 2 guard: 0 before any question work; 1 once a QUESTION test has tasks', async () => {
    expect(num((await sqlFile(post, release.codeRollbackCheck))[0])).toEqual({ question_tests_with_tasks: 0, composed_markings: 0 });
    expect(num((await sqlFile(seeded, release.codeRollbackCheck))[0])).toEqual({ question_tests_with_tasks: 1, composed_markings: 0 });
  });

  it('level 3: refused without evidence, refused with a stale manifest, done with a fresh one; schema and pre-release rows restored; history; re-apply', async () => {
    const target = await newDb('qm_target', seeded);
    const before = await state(target);
    // 1. No evidence: refused, nothing changed (acknowledgement is not even an option for this release).
    await expect(kit.rollbackRelease(url(target), release, quiet)).rejects.toThrow(/QUESTION_MARKING_ROLLBACK_REFUSED: 4 question-marking row\(s\) and 1 QUESTION-mode test\(s\) exist and no verified backup manifest/);
    expect(await state(target)).toEqual(before);
    expect(rel.resolveAcknowledgements(['bank-details'], release).ok).toBe(false);
    // 2. A verified backup: the restored scratch copy equals the target, so a manifest is written, with CSVs from the copy.
    const v = await verified(target);
    expect(v.manifest).toMatchObject({ release: 'question-marking-2027', verified: true, tables: { TestQuestionTask: { count: '2' }, TestTaskEvent: { count: '2' }, 'Test.markingMode': { count: '1' } } });
    expect(v.manifest.csv.files).toMatchObject({ TestQuestionTask: 2, TestTaskEvent: 2, 'TestMarking.COMPOSED': 0 });
    expect(readFileSync(`${v.manifestFile.replace(/\.manifest\.json$/, '')}.csv/TestQuestionTask.csv`, 'utf8')).toMatch(/^id,submissionId,questionId,round/);
    // 3. Data written after the backup (one more event): the same manifest is stale. Refused inside the transaction; nothing changed.
    await withDb(target, (c) => c.query(`INSERT INTO "TestTaskEvent" ("id", "taskId", "action", "actorRole", "createdAt") VALUES ('rq-event-late', 'rq-task-1', 'PAPER_OPENED', 'MENTOR', '2026-12-04')`));
    const changed = await state(target);
    await expect(kit.rollbackRelease(url(target), release, { ...quiet, evidence: v.evidence })).rejects.toThrow(/TestTaskEvent differs from the verified backup \(live 3 row\(s\); manifest 2 row\(s\)\)/);
    expect(await state(target)).toEqual(changed);
    // A backup that does not match the target is never verified (the scratch copy of another database).
    const other = await backupOf(seeded);
    await expect(kit.verifyBackup({ release, targetUrl: url(target), scratchUrl: url(await newDb('qm_scratch')), dumpFile: other.file, restoreFile: other.restoreFile, log: () => undefined }))
      .rejects.toThrow(/the restored backup differs from the target: TestTaskEvent: backup 2 row\(s\), target 3 row\(s\)/);
    // The scratch database must be separate and empty.
    await expect(kit.verifyBackup({ release, targetUrl: url(target), scratchUrl: url(target), dumpFile: other.file, restoreFile: other.restoreFile })).rejects.toThrow(/SEPARATE database/);
    await expect(kit.verifyBackup({ release, targetUrl: url(target), scratchUrl: url(pre), dumpFile: other.file, restoreFile: other.restoreFile })).rejects.toThrow(/scratch database is not empty/);
    // 4. A fresh verified backup: the rollback runs both files (the kind file only checks).
    const fresh = await verified(target);
    const r = await kit.rollbackRelease(url(target), release, { ...quiet, evidence: fresh.evidence });
    expect(r).toEqual({ ran: ['20270101000100_question_marking.rollback.sql', '20270101000000_question_marking_kind.rollback.sql'], skipped: [], stopped: false });
    // 5. History, then: the schema of before the release (COMPOSED kept), every pre-release row unchanged.
    expect(await kit.rollbackHistoryRelease(url(target), release, { log: () => undefined, error: () => undefined, root: ROOT })).toBe(0);
    const after = await state(target);
    const keptValue = (s: string[]) => s.map((l) => (l.startsWith('enum TestMarkingKind ') ? l.replace(/,COMPOSED$/, '') : l));
    expect(keptValue(after.schema)).toEqual(preState.schema);
    expect(after.schema.find((l) => l.startsWith('enum TestMarkingKind '))).toMatch(/,COMPOSED$/);
    expect(after.data).toEqual(preState.data);
    // 6. Run again: nothing left to do (resumable), still the same.
    const again = await kit.rollbackRelease(url(target), release, quiet);
    expect(again.skipped).toEqual(['20270101000100_question_marking.rollback.sql']);
    expect(await state(target)).toEqual(after);
    // 7. Re-apply both migrations: the release schema again; ADD VALUE IF NOT EXISTS is a no-op.
    await withDb(target, async (c) => { for (const m of QM) await db.applyMigration(c, ROOT, m); });
    expect(await withDb(target, schemaOf)).toEqual(postSchema);
    expect(num((await sqlFile(target, release.postcheck))[1])).toMatchObject({ question_marking_tables: 11, question_marking_rows: 0, composed_kind: 1 });
  });

  it('a COMPOSED final marking: refused whatever the evidence; both files say roll forward; nothing changed', async () => {
    const target = await newDb('qm_composed', seeded);
    await withDb(target, (c) => c.query(`INSERT INTO "TestMarking" ("id", "submissionId", "kind", "markerId", "versionId", "status", "createdAt", "updatedAt")
      VALUES ('rq-composed', 'rq-q-sub', 'COMPOSED', 'rq-admin', 'rq-q-sub-v1', 'DRAFT', '2026-12-05', '2026-12-05')`));
    const before = await state(target);
    const v = await verified(target);
    await expect(kit.rollbackRelease(url(target), release, { ...quiet, evidence: v.evidence })).rejects.toThrow(/1 COMPOSED final marking\(s\) exist .*Roll forward instead/);
    expect(await state(target)).toEqual(before);
    expect(num((await sqlFile(target, release.codeRollbackCheck))[0])).toEqual({ question_tests_with_tasks: 1, composed_markings: 1 });
  });

  it('with no question data at all, the rollback needs no evidence and restores the pre-release schema', async () => {
    const target = await newDb('qm_empty', post);
    const r = await kit.rollbackRelease(url(target), release, quiet);
    expect(r.ran).toHaveLength(2);
    expect(await kit.rollbackHistoryRelease(url(target), release, { log: () => undefined, error: () => undefined, root: ROOT })).toBe(0);
    const after = await state(target);
    expect(after.schema.map((l) => (l.startsWith('enum TestMarkingKind ') ? l.replace(/,COMPOSED$/, '') : l))).toEqual(preState.schema);
    expect(after.data).toEqual(preState.data);
  });
});
