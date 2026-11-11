/**
 * School directory S2a — sync staging: dry runs, reports, expiry, purge (owner-approved 2026-11-11).
 *
 *   M13: staging tables only; rollback refuses while runs exist (unless acknowledged) and never
 *        touches the directory; run status guard (APPLIED / SUPERSEDED final; never deleted).
 *   Dry run (schools.manage): the configured dataset only; every matching and conflict rule;
 *        WRITE BOUNDARY — every directory table identical (checksums) after any number of dry runs.
 *   Reports: contact values masked in items and changes, absent from report.csv; S1 history masks
 *        the raw source rows (stored rows unchanged).
 *   Lifecycle: expiry after 24 h; daily purge of staged values 7 days after a run ended (expired,
 *        superseded or applied) — summaries, digests, decisions and links kept; source records and
 *        the directory untouched; idempotent.
 * All data is synthetic (src/schools/sync/nesa-fixture.testing.ts); the real NESA workbook is
 * never used.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

import { SchoolSyncService } from '../src/schools/sync/school-sync.service.js';
import { nesaRow, nesaWorkbook, type NesaRow } from '../src/schools/sync/nesa-fixture.testing.js';
import { schoolKey } from '../src/schools/school-key.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const ROOT = join(__dirname, '..');
const body = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n').split('\n')
  .filter((l) => !/^(BEGIN|COMMIT);$/.test(l.trim())).join('\n');
const M13 = body('prisma/migrations/20261121001200_school_directory_sync/migration.sql');
const M13_ROLLBACK = body('docs/migrations/20261121001200_school_directory_sync.rollback.sql');
const DATASET = 'NESA:ACCREDITED_SCHOOLS';
const DIRECTORY_TABLES = [
  'School', 'SchoolContact', 'SchoolEducationLevel', 'SchoolProgramme', 'Programme', 'SchoolExternalId', 'SchoolSourceRecord',
  'EducationLevel', 'SchoolDataSource', 'StudentSchoolAffiliation', 'StudentEnrollment', 'TeacherSchoolAssignment',
];

async function servesConcurrentConnections(): Promise<boolean> {
  const url = process.env.TEST_DATABASE_URL!;
  const holder = new pg.Client({ connectionString: url });
  const other  = new pg.Client({ connectionString: url, query_timeout: 2000 });
  await holder.connect();
  await other.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1');
    return await other.query('SELECT 1').then(() => true, () => false);
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end().catch(() => undefined);
    await other.end().catch(() => undefined);
  }
}

describe('School directory sync — S2a staging', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, teacher: string, headCoach: string, coach: string, student: string;
  let ngoma: string, karama: string, missing: string, kacyiru: string, legacy: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const R = '/api/v1/admin/school-sync/runs';
  const RW = { province: 'Southern Province', district: 'Huye', sector: 'Ngoma' };
  const errorCode = (r: { status: number; body?: any }) => (r.status >= 400 ? r.body?.code ?? null : null);
  const upload = (buffer: Buffer, token = admin, q: Record<string, string> = { dataset: DATASET }, filename = 'nesa-export.xlsx') =>
    http().post(R).query(q).set(bearer(token)).attach('file', buffer, { filename, contentType: 'application/octet-stream' });
  const service = () => ctx.app.get(SchoolSyncService);
  const pgClient = async () => { const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); return c; };
  /** md5 of every row of every directory table (the write boundary). */
  const directoryChecksum = async () => Object.fromEntries(await Promise.all(DIRECTORY_TABLES.map(async (t) => {
    const [r] = await p().$queryRawUnsafe<Array<{ h: string; n: number }>>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h, count(*)::int AS n FROM "${t}" t`);
    return [t, `${r.n}:${r.h}`];
  })));
  const all = async (url: string, token = admin) => {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const r = await http().get(url).query({ page, limit: 100 }).set(bearer(token)).expect(200);
      out.push(...r.body.data);
      if (page >= r.body.meta.totalPages) return out;
    }
  };

  // Synthetic contact values (reserved example domain, unassigned numbers).
  const CONTACTS = ['head.ngoma@example.org', 'known@example.org', 'new.karama@example.org', '0788 555 101', '0788555101', '788555101', '0722 555 202', '722555202'];
  const ROWS: Array<Partial<NesaRow>> = [
    /* 2 */ { 'School Name': 'GS NGOMA', 'School Code': '220001', Email: 'head.ngoma@example.org', Phone: '0788 555 101' },
    /* 3 */ { 'School Name': 'EP KARAMA', 'School Code': '220002', Cell: 'Butare', Village: 'Gako', Email: 'known@example.org; new.karama@example.org', Phone: 'No Primary' },
    /* 4 */ { 'School Name': 'EP NEW SCHOOL', 'School Code': '220777', Phone: '0722 555 202' },
    /* 5 */ { 'School Name': 'EP KARAMA', 'School Code': '220002', Cell: 'Butare', Village: 'Gako', Email: 'known@example.org; new.karama@example.org', Phone: 'No Primary' },
    /* 6 */ { 'School Name': 'EP DISPUTED ONE', 'School Code': '220500' },
    /* 7 */ { 'School Name': 'EP DISPUTED TWO', 'School Code': '220500' },
    /* 8 */ { 'School Name': 'EP WRONG PROVINCE', 'School Code': '120009' },
    /* 9 */ { 'School Name': 'EP KACYIRU NEW', 'School Code': 'N/A', Province: 'Kigali City', District: 'Gasabo', Sector: 'Kacyiru', Phone: '07881234O6' },
    /* 10 */ { 'School Name': '' },
    /* 11 */ { 'School Name': 'EP TUMBA NSHYA', Sector: 'Tumba Nshya', 'School Code': 'SDMS CODE: 340209' },
    /* 12 */ { 'School Name': 'Test School', 'School Code': '-' },
    /* 13 */ { 'School Name': 'EP TOTALLY DIFFERENT', 'School Code': '110001', Province: 'Kigali City', District: 'Nyarugenge', Sector: 'Muhima' },
  ];
  let fixture: Buffer;

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    student = await login(ctx, 'student.j');
    const official = async (name: string, code: string, place: typeof RW) => (await p().school.create({ data: {
      name, code, nameKey: schoolKey(name), location: `${place.sector}, ${place.district}`, ...place, ownership: 'PUBLIC', source: 'OFFICIAL_LIST',
    } })).id;
    ngoma = await official('GS NGOMA — Huye', '220001', RW);   // M8's suffix
    karama = await official('EP KARAMA', '220002', RW);
    missing = await official('ES NOT IN THE FILE', '220003', { ...RW, sector: 'Tumba' });
    kacyiru = await official('GS KACYIRU', '110001', { province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' });
    legacy = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    await p().schoolContact.create({ data: { schoolId: karama, type: 'EMAIL', value: 'known@example.org' } });
    await p().schoolEducationLevel.create({ data: { schoolId: karama, levelCode: 'PR' } });
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    for (const [username, role] of [['ss.teacher', 'TEACHER'], ['ss.head', 'HEAD_COACH'], ['ss.super', 'SUPER_ADMIN']] as const) {
      await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
    }
    [teacher, headCoach, superAdmin] = await Promise.all(['ss.teacher', 'ss.head', 'ss.super'].map((u) => login(ctx, u)));
    fixture = await nesaWorkbook(ROWS.map((r) => nesaRow(r)), { summary: [['Total', ROWS.length, `COUNTA('All Schools'!A2:A${ROWS.length + 1})`], ['South', 10], ['Kigali City', 2]] });
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  // ─── M13 ─────────────────────────────────────────────────────────────────────

  it('M13 (the real SQL): rollback removes only its objects (directory identical); re-applying recreates them', async () => {
    const before = await directoryChecksum();
    const c = await pgClient();
    const q = async (sql: string) => (await c.query(sql)).rows;
    const objects = async () => (await q(`SELECT
        (SELECT count(*)::int FROM information_schema.tables WHERE table_name IN ('SchoolSyncRun', 'SchoolSyncItem', 'SchoolSyncChange')) AS tables,
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'SchoolSourceRecord' AND column_name = 'syncRunId') AS col,
        (SELECT count(*)::int FROM pg_proc WHERE proname IN ('school_sync_run_guard', 'school_sync_staging_keep')) AS fns,
        (SELECT count(*)::int FROM pg_type WHERE typname IN ('SchoolSyncRunStatus', 'SchoolSyncItemOutcome', 'SchoolSyncChangeKind', 'SchoolSyncDecision', 'SchoolSyncConflictState')) AS types`))[0];
    try {
      await c.query('BEGIN');
      await c.query(M13_ROLLBACK);
      expect(await objects()).toEqual({ tables: 0, col: 0, fns: 0, types: 0 });
      await c.query(M13);
      expect(await objects()).toEqual({ tables: 3, col: 1, fns: 2, types: 5 });
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await directoryChecksum()).toEqual(before);
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  it('schools.manage only: every S2a route 403 for Teachers, Head Coaches, Coaches and Students, 401 anonymous', async () => {
    const fake = '00000000-0000-4000-8000-000000000000';
    const gets = [R, `${R}/${fake}`, `${R}/${fake}/items`, `${R}/${fake}/changes`, `${R}/${fake}/report.csv`];
    for (const token of [teacher, headCoach, coach, student]) {
      for (const url of gets) expect([url, (await http().get(url).set(bearer(token))).status]).toEqual([url, 403]);
      expect((await upload(fixture, token)).status).toBe(403);
    }
    for (const url of gets) expect([url, (await http().get(url)).status]).toEqual([url, 401]);
    expect((await http().post(R).query({ dataset: DATASET }).attach('file', fixture, 'x.xlsx')).status).toBe(401);
    for (const token of [admin, superAdmin]) {
      await http().get(R).set(bearer(token)).expect(200);
      for (const url of gets.slice(1)) expect([url, (await http().get(url).set(bearer(token))).status]).toEqual([url, 404]);
    }
    expect(await p().schoolSyncRun.count()).toBe(0);
  });

  // ─── Dry run ───────────────────────────────────────────────────────────────

  let runId: string;

  it('dry run: the configured dataset only (an unknown key refused; the workbook never chooses it); file checks first', async () => {
    expect(errorCode(await upload(fixture, admin, { dataset: 'NESA:SOMETHING_ELSE' }))).toBe('VALIDATION_FAILED');
    expect(errorCode(await upload(fixture, admin, {}))).toBe('VALIDATION_FAILED');
    expect(errorCode(await http().post(R).query({ dataset: DATASET }).set(bearer(admin)))).toBe('FILE_REQUIRED');
    expect(errorCode(await upload(await nesaWorkbook([nesaRow()], { sheet: 'Schools' })))).toBe('SYNC_SHEET_MISSING');
    expect(errorCode(await upload(Buffer.from('a,b\n1,2'), admin, { dataset: DATASET }, 'x.csv'))).toBe('INVALID_SYNC_HEADER');
    expect(await p().schoolSyncRun.count()).toBe(0);
  });

  it('dry run: every matching and conflict rule; the comparison staged with digests; audited (counts only); 24 h to review', async () => {
    const before = await directoryChecksum();
    const res = await upload(fixture).expect(201);
    runId = res.body.id;
    expect(res.body).toMatchObject({
      datasetKey: DATASET, normaliserVersion: 'nesa-v1', dataSource: { key: 'NESA' }, fileName: 'nesa-export.xlsx', format: 'xlsx',
      rowCount: ROWS.length, status: 'PREVIEW', reviewGeneration: 0, expired: false, stagedPurged: false, createdBy: { username: 'admin' },
      reportDigest: expect.stringMatching(/^[0-9a-f]{64}$/), decisionsDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(new Date(res.body.expiresAt).getTime() - new Date(res.body.createdAt).getTime()).toBe(24 * 60 * 60 * 1000);
    expect(res.body.reconciliation).toMatchObject({ summaryAvailable: true, rowsRead: ROWS.length });
    expect(res.body.reconciliation.checks.map((c: any) => [c.label, c.source, c.read, c.matches])).toEqual([['Total', 12, 12, true], ['South', 10, 10, true], ['Kigali City', 2, 2, true]]);

    const items = await all(`${R}/${runId}/items`);
    const byRow = Object.fromEntries(items.filter((i) => i.rowNumber).map((i) => [i.rowNumber, [i.outcome, i.schoolId, i.matchedBy]]));
    expect(byRow).toEqual({
      2: ['MATCHED', ngoma, 'CODE'], 3: ['MATCHED', karama, 'CODE'], 4: ['NEW', null, null], 5: ['DUPLICATE_ROW', karama, null],
      6: ['CONFLICT', null, null], 7: ['CONFLICT', null, null], 8: ['CONFLICT', null, null], 9: ['NEW', null, null],
      10: ['INVALID', null, null], 11: ['NEW', null, null], 12: ['POSSIBLE_DUPLICATE', null, null], 13: ['CONFLICT', null, null],
    });
    expect(items.find((i) => i.rowNumber === 13).details).toMatchObject({ reasons: ['CODE_MATCHES_A_DIFFERENT_SCHOOL'], schoolId: kacyiru });
    expect(items.find((i) => i.rowNumber === 6)).toMatchObject({ conflictState: 'OPEN', conflictGroup: 'code:220500' });
    expect(items.find((i) => i.rowNumber === 12).details.candidates.map((c: any) => c.id)).toContain(legacy);
    expect(items.filter((i) => i.outcome === 'MISSING_FROM_SOURCE').map((i) => i.schoolId)).toEqual([missing]);
    expect(items.find((i) => i.rowNumber === 11).issues.map((x: any) => x.code)).toEqual(expect.arrayContaining(['NEW_PLACE', 'CODE_UNUSABLE']));

    const changes = await all(`${R}/${runId}/changes`);
    const of = (kind: string) => changes.filter((c) => c.kind === kind);
    expect(of('NAME_RESTORE').map((c) => [c.schoolId, c.field, c.currentValue, c.publishedValue])).toEqual([[ngoma, 'name', 'GS NGOMA — Huye', 'GS NGOMA']]);
    expect(of('FILL_EMPTY').filter((c) => c.schoolId === karama).map((c) => [c.field, c.publishedValue]).sort((x, y) => x[0].localeCompare(y[0])))
      .toEqual([['accommodation', 'DAY'], ['cell', 'Butare'], ['village', 'Gako']]);
    expect(of('CREATE_SCHOOL').map((c) => [c.item.rowNumber, c.publishedValue.code])).toEqual([[4, '220777'], [9, null], [11, null]]);
    expect(of('NEW_PLACE').map((c) => [c.publishedValue.sector, c.publishedValue.rows])).toEqual([['Tumba Nshya', [11]]]);
    expect(of('ADD_CONTACT').map((c) => [c.item.rowNumber, c.field, c.publishedValue.masked])).toEqual(expect.arrayContaining([
      [2, 'EMAIL', 'h•••@e•••.org'], [2, 'PHONE', '+250•••01'], [3, 'EMAIL', 'n•••@e•••.org'], [4, 'PHONE', '+250•••02'],
    ]));
    expect(of('ADD_CONTACT').filter((c) => c.schoolId === karama)).toHaveLength(1);   // "known@" is already there
    expect(of('ADD_LEVEL').filter((c) => c.schoolId === karama)).toEqual([]);         // PR already there
    expect(changes.every((c) => c.decision === 'PENDING')).toBe(true);
    expect(changes.filter((c) => [6, 7, 8, 10, 12, 13].includes(c.item?.rowNumber))).toEqual([]);   // nothing proposed for conflicts, invalid, possible duplicates

    const log = await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_SYNC_DRY_RUN', entityId: runId } });
    expect(log).toMatchObject({ actorId: ctx.ids.admin, entity: 'SchoolSyncRun' });
    expect(log.metadata).toMatchObject({ datasetKey: DATASET, rows: 12, counts: { outcomes: { MATCHED: 2, NEW: 3, CONFLICT: 4, DUPLICATE_ROW: 1, INVALID: 1, POSSIBLE_DUPLICATE: 1, MISSING_FROM_SOURCE: 1 } } });
    expect(await directoryChecksum()).toEqual(before);   // the write boundary
  });

  it('WRITE BOUNDARY (G): any number of dry runs, by Administrators and Super Admins, leave every directory table identical', async () => {
    const before = await directoryChecksum();
    await upload(fixture, superAdmin).expect(201);
    await upload(fixture, admin, { dataset: DATASET, label: 'Second look' }).expect(201);
    expect(await directoryChecksum()).toEqual(before);
    expect(await p().schoolSyncRun.count()).toBe(3);
    const runs = await http().get(R).query({ datasetKey: DATASET, status: 'PREVIEW' }).set(bearer(admin)).expect(200);
    expect(runs.body.data.map((r: any) => r.datasetLabel)).toEqual(['Second look', expect.any(String), expect.any(String)]);
  });

  // ─── Privacy ───────────────────────────────────────────────────────────────

  it('C: items, changes and report.csv never show a contact value (Administrator and Super Admin); the CSV has no contact column', async () => {
    for (const token of [admin, superAdmin]) {
      const items = JSON.stringify(await all(`${R}/${runId}/items`, token));
      const changes = JSON.stringify(await all(`${R}/${runId}/changes`, token));
      const run = JSON.stringify((await http().get(`${R}/${runId}`).set(bearer(token)).expect(200)).body);
      const csv = (await http().get(`${R}/${runId}/report.csv`).set(bearer(token)).expect(200)).text;
      for (const secret of [...CONTACTS, '07881234O6']) {
        expect([secret, items.includes(secret), changes.includes(secret), run.includes(secret), csv.includes(secret)]).toEqual([secret, false, false, false, false]);
      }
      expect(csv.split('\r\n')[0]).toBe('﻿Row,Source ref,Outcome,Matched by,School id,Code (as published),Name (as published),Province,District,Sector,Proposed changes,Usable contacts (count only),Issues');
      expect(csv).not.toMatch(/e-?mail|phone/i);
    }
    // The staged copies do hold the values (until the purge) — only the responses mask them.
    const staged = await p().schoolSyncItem.findFirstOrThrow({ where: { runId, rowNumber: 2 } });
    expect((staged.raw as any).Email).toBe('head.ngoma@example.org');
    const dryRunAudit = JSON.stringify(await p().auditLog.findMany({ where: { action: 'SCHOOL_SYNC_DRY_RUN' }, select: { metadata: true } }));
    for (const secret of CONTACTS) expect([secret, dryRunAudit.includes(secret)]).toEqual([secret, false]);
    expect(dryRunAudit).not.toContain('example.org');
  });

  it('R6: the school history masks contact values in source records for Administrators and Super Admins; the stored record is unchanged', async () => {
    const nesa = await p().schoolDataSource.findUniqueOrThrow({ where: { key: 'NESA' } });
    const raw = { ...nesaRow({ 'School Name': 'EP KARAMA', 'School Code': '220002', Email: 'known@example.org; new.karama@example.org', Phone: '0788 555 101' }) };
    const rec = await p().schoolSourceRecord.create({ data: {
      dataSourceId: nesa.id, datasetLabel: 'synthetic', datasetSha256: 'c'.repeat(64), sourceRef: 'All Schools!3', raw, rowHash: 'd'.repeat(64), schoolId: karama, matchedBy: 'CODE', syncRunId: runId,
    } });
    for (const token of [admin, superAdmin]) {
      const h = (await http().get(`/api/v1/admin/schools/${karama}/history`).set(bearer(token)).expect(200)).body;
      const shown = h.sourceRecords.find((r: any) => r.id === rec.id);
      expect(shown.raw).toMatchObject({ 'School Name': 'EP KARAMA', 'School Code': '220002', Email: 'k•••@e•••.org; n•••@e•••.org', Phone: '+250•••01' });
      for (const s of CONTACTS) expect([s, JSON.stringify(h).includes(s)]).toEqual([s, false]);
    }
    expect((await p().schoolSourceRecord.findUniqueOrThrow({ where: { id: rec.id } })).raw).toEqual(raw);
  });

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  it('run guard (real SQL): status moves only forward; APPLIED and SUPERSEDED are final (only stagedPurgedAt may be set); runs, items and changes are never deleted', async () => {
    const [a, b] = (await p().schoolSyncRun.findMany({ where: { id: { not: runId } }, select: { id: true } })).map((r) => r.id);
    const sql = (s: string, ...v: unknown[]) => p().$executeRawUnsafe(s, ...v);
    await sql(`UPDATE "SchoolSyncRun" SET status = 'APPLIED', "appliedAt" = now() - interval '8 days' WHERE id = $1`, a);
    await expect(sql(`UPDATE "SchoolSyncRun" SET status = 'SUPERSEDED', "supersededAt" = now() WHERE id = $1`, a)).rejects.toThrow(/SCHOOL_SYNC_RUN_STATUS/);
    await expect(sql(`UPDATE "SchoolSyncRun" SET "reviewGeneration" = 5 WHERE id = $1`, a)).rejects.toThrow(/SCHOOL_SYNC_RUN_FINAL/);
    await expect(sql(`UPDATE "SchoolSyncRun" SET status = 'PREVIEW' WHERE id = $1`, a)).rejects.toThrow(/SCHOOL_SYNC_RUN_STATUS/);
    await sql(`UPDATE "SchoolSyncRun" SET status = 'SUPERSEDED', "supersededAt" = now() - interval '8 days', "supersededByRunId" = $2 WHERE id = $1`, b, a);
    await expect(sql(`UPDATE "SchoolSyncRun" SET "datasetLabel" = 'x' WHERE id = $1`, b)).rejects.toThrow(/SCHOOL_SYNC_RUN_FINAL/);
    await expect(sql(`DELETE FROM "SchoolSyncRun" WHERE id = $1`, b)).rejects.toThrow(/SCHOOL_SYNC_HISTORY_PERMANENT/);
    await expect(sql(`DELETE FROM "SchoolSyncItem" WHERE "runId" = $1`, b)).rejects.toThrow(/SCHOOL_SYNC_HISTORY_PERMANENT/);
    await expect(sql(`DELETE FROM "SchoolSyncChange" WHERE "runId" = $1`, b)).rejects.toThrow(/SCHOOL_SYNC_HISTORY_PERMANENT/);
    expect((await p().schoolSyncRun.findMany({ where: { id: { in: [a, b] } }, orderBy: { status: 'asc' }, select: { status: true } })).map((r) => r.status).sort()).toEqual(['APPLIED', 'SUPERSEDED']);
  });

  it('expiry after 24 h, then the daily purge 7 days after a run ended — expired, superseded and applied runs; summaries, digests, decisions and links kept; source records and directory untouched; idempotent', async () => {
    const realNow = service().now;
    const at = (ms: number) => { service().now = () => new Date(Date.now() + ms); };
    const H = 60 * 60 * 1000;
    try {
      const before = await directoryChecksum();
      const sourceRecords = JSON.stringify(await p().schoolSourceRecord.findMany({ orderBy: { id: 'asc' } }));
      const runsBefore = await p().schoolSyncRun.findMany({ orderBy: { id: 'asc' }, select: { id: true, counts: true, reportDigest: true, decisionsDigest: true, reconciliation: true } });

      at(23 * H);
      expect(await service().expireRuns()).toBe(0);
      at(25 * H);
      expect(await service().expireRuns()).toBe(1);   // the one PREVIEW run left (runId)
      expect((await http().get(`${R}/${runId}`).set(bearer(admin)).expect(200)).body).toMatchObject({ status: 'EXPIRED' });
      expect(await p().auditLog.count({ where: { action: 'SCHOOL_SYNC_RUN_EXPIRED', entityId: runId } })).toBe(1);
      expect(await service().purgeStaging()).toBe(2);   // the applied and the superseded run (ended 8 days ago); runId expired only 1 hour ago

      at((24 + 7 * 24 + 2) * H);
      expect(await service().purgeStaging()).toBe(1);   // now runId too
      expect(await service().purgeStaging()).toBe(0);   // idempotent
      expect(await p().auditLog.count({ where: { action: 'SCHOOL_SYNC_STAGING_PURGED' } })).toBe(3);

      const [left] = await p().$queryRawUnsafe<Array<{ items: number; changes: number }>>(`SELECT
          (SELECT count(*)::int FROM "SchoolSyncItem" WHERE raw IS NOT NULL OR normalized IS NOT NULL) AS items,
          (SELECT count(*)::int FROM "SchoolSyncChange" WHERE "currentValue" IS NOT NULL OR "publishedValue" IS NOT NULL) AS changes`);
      expect(left).toEqual({ items: 0, changes: 0 });
      // Kept: summaries, counts, digests, outcomes, kinds, decisions, links.
      expect(await p().schoolSyncRun.findMany({ orderBy: { id: 'asc' }, select: { id: true, counts: true, reportDigest: true, decisionsDigest: true, reconciliation: true } })).toEqual(runsBefore);
      expect(await p().schoolSyncRun.count({ where: { stagedPurgedAt: null } })).toBe(0);
      const items = await all(`${R}/${runId}/items`);
      expect(items.find((i) => i.rowNumber === 2)).toMatchObject({ outcome: 'MATCHED', schoolId: ngoma, raw: null, normalized: null });
      const changes = await all(`${R}/${runId}/changes`);
      expect(changes.find((c) => c.kind === 'NAME_RESTORE')).toMatchObject({ schoolId: ngoma, field: 'name', decision: 'PENDING', currentValue: null, publishedValue: null });
      expect((await http().get(`${R}/${runId}`).set(bearer(admin)).expect(200)).body).toMatchObject({ stagedPurged: true });
      await http().get(`${R}/${runId}/report.csv`).set(bearer(admin)).expect(200);   // still a report (outcomes only)
      // Never touched: source records (immutable, permanent) and the directory.
      expect(JSON.stringify(await p().schoolSourceRecord.findMany({ orderBy: { id: 'asc' } }))).toBe(sourceRecords);
      expect(await directoryChecksum()).toEqual(before);
    } finally {
      service().now = realNow;
    }
  });

  it('M13 rollback refuses while runs exist (nothing changed), and succeeds only when the loss of sync history is acknowledged — never touching the directory', async () => {
    const before = await directoryChecksum();
    const c = await pgClient();
    const attempt = async (ack: boolean) => {
      await c.query('BEGIN');
      try {
        if (ack) await c.query(`SET LOCAL rof.m13_rollback = 'discard-sync-history'`);
        await c.query(M13_ROLLBACK);
        return (await c.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'SchoolSyncRun'`)).rows[0].n;
      } catch (err) {
        return (err as Error).message;
      } finally {
        await c.query('ROLLBACK');
      }
    };
    try {
      expect(await attempt(false)).toMatch(/M13_ROLLBACK_REFUSED: 3 sync runs .* would be lost; nothing was changed/);
      expect(await attempt(true)).toBe(0);
    } finally {
      await c.end();
    }
    expect(await p().schoolSyncRun.count()).toBe(3);
    expect(await directoryChecksum()).toEqual(before);
  });

  // ─── Size ──────────────────────────────────────────────────────────────────

  it('a 5,000-school file: one dry run (PostgreSQL in CI, within 60 s), every row staged, the directory untouched', async (test) => {
    if (!(await servesConcurrentConnections())) {
      if (process.env.CI) throw new Error('CI database must be PostgreSQL for this test.');
      test.skip('local single-connection database (prisma dev): runs in CI on PostgreSQL');
      return;
    }
    const rows = Array.from({ length: 5000 }, (_, i) => nesaRow({
      'School Name': `EP SCALE ${i}`, 'School Code': i % 3 === 0 ? String(220_000 + 1000 + i).slice(0, 6) : 'N/A',
      Village: `V${i}`, Email: `s${i}@example.org`,
      'Combinations/Trades/Other Programmes': i % 5 === 0 ? 'MATHEMATICS-CHEMISTRY-BIOLOGY (MCB)' : '',
    }));
    const file = await nesaWorkbook(rows);
    const before = await directoryChecksum();
    const started = Date.now();
    const res = await upload(file).expect(201);
    const ms = Date.now() - started;
    console.log(`S2a dry run, 5,000 rows: ${ms} ms`);
    expect(ms).toBeLessThan(60_000);
    expect(res.body.rowCount).toBe(5000);
    expect(await p().schoolSyncItem.count({ where: { runId: res.body.id, rowNumber: { not: null } } })).toBe(5000);
    expect(await directoryChecksum()).toEqual(before);
  }, 180_000);
});
