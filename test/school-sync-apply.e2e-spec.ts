/**
 * School directory S2b — review, decisions, approval and apply (owner-approved 2026-11-11).
 *
 *   M14: approval columns, retired changes, the run guard letting a deleted user's reference
 *        become NULL; rollback refuses while approval history exists unless acknowledged.
 *   Permissions: review for schools.manage; approve / apply / resolve and RESOLVE_CONFLICT
 *        decisions for Super Admins only (schools.syncDirectory) — enforced by the backend.
 *   Decisions: per field; categories bound to the list digest; NEW_PLACE / CREATE_SCHOOL
 *        dependencies; rejected and pending changes never applied.
 *   Apply: one locked, atomic, audited transaction; ids and relationships kept; never deactivates;
 *        source records for every row; external ids; idempotent; stale review → 409 with zero
 *        writes; supersession of earlier open runs only.
 *   Resolutions: proposals, Super Admin decisions with recompare, post-apply link (identifiers
 *        only).
 *   Concurrency (PostgreSQL in CI): competing applies, both run orders, school writes and claims
 *        against an apply, recompare's whole-transaction retry.
 * All data is synthetic (src/schools/sync/nesa-fixture.testing.ts).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

import { AuditService } from '../src/audit/audit.service.js';
import { SchoolAffiliationService } from '../src/schools/affiliations/school-affiliation.service.js';
import { schoolKey } from '../src/schools/school-key.js';
import { nesaRow, nesaWorkbook, type NesaRow } from '../src/schools/sync/nesa-fixture.testing.js';
import { SchoolSyncApplyService } from '../src/schools/sync/review/school-sync-apply.service.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const ROOT = join(__dirname, '..');
const body = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n').split('\n')
  .filter((l) => !/^(BEGIN|COMMIT);$/.test(l.trim())).join('\n');
const M14 = body('prisma/migrations/20261121001300_school_directory_sync_approval/migration.sql');
const M14_ROLLBACK = body('docs/migrations/20261121001300_school_directory_sync_approval.rollback.sql');
const DATASET = 'NESA:ACCREDITED_SCHOOLS';
const DIRECTORY_TABLES = [
  'School', 'SchoolContact', 'SchoolEducationLevel', 'SchoolProgramme', 'Programme', 'SchoolExternalId', 'SchoolSourceRecord',
  'StudentSchoolAffiliation', 'StudentEnrollment', 'TeacherSchoolAssignment', 'User',
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

describe('School directory sync — S2b review and apply', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, superAdmin2: string, teacher: string, headCoach: string, coach: string, student: string;
  let superAdminId: string;
  let ngoma: string, karama: string, missing: string, kacyiru: string, legacy: string;
  let karamaStudent: string, teacherId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const R = '/api/v1/admin/school-sync/runs';
  const RW = { province: 'Southern Province', district: 'Huye', sector: 'Ngoma' };
  const errorCode = (r: { status: number; body?: any }) => (r.status >= 400 ? r.body?.code ?? null : null);
  const pgClient = async () => { const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); return c; };
  const checksum = async () => Object.fromEntries(await Promise.all(DIRECTORY_TABLES.map(async (t) => {
    const [r] = await p().$queryRawUnsafe<Array<{ h: string; n: number }>>(`SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h, count(*)::int AS n FROM "${t}" t`);
    return [t, `${r.n}:${r.h}`];
  })));
  const upload = async (rows: Array<Partial<NesaRow>> | Buffer, token = admin) => {
    const file = Buffer.isBuffer(rows) ? rows : await nesaWorkbook(rows.map((r) => nesaRow(r)));
    return (await http().post(R).query({ dataset: DATASET }).set(bearer(token)).attach('file', file, { filename: 'nesa.xlsx', contentType: 'application/octet-stream' }).expect(201)).body.id as string;
  };
  const all = async (url: string, token = admin) => {
    const out: any[] = [];
    for (let page = 1; ; page++) {
      const r = await http().get(url).query({ page, limit: 100 }).set(bearer(token)).expect(200);
      out.push(...r.body.data);
      if (page >= r.body.meta.totalPages) return out;
    }
  };
  const changesOf = (runId: string) => all(`${R}/${runId}/changes`);
  const itemsOf = (runId: string) => all(`${R}/${runId}/items`);
  const decide = (runId: string, b: object, token = admin) => http().post(`${R}/${runId}/decisions`).set(bearer(token)).send(b);
  const categoryDigest = async (runId: string, kind: string) =>
    ((await http().get(`${R}/${runId}/categories`).set(bearer(admin)).expect(200)).body as any[]).find((c) => c.kind === kind).listDigest as string;
  const approveCategories = async (runId: string, kinds: string[], token = admin) =>
    decide(runId, { categories: await Promise.all(kinds.map(async (kind) => ({ kind, listDigest: await categoryDigest(runId, kind) }))) }, token).expect(200);
  const approveRun = async (runId: string, token = superAdmin) => (await http().post(`${R}/${runId}/approve`).set(bearer(token)).expect(200)).body;
  const applyRun = (runId: string, applyToken: string, token = superAdmin) => http().post(`${R}/${runId}/apply`).set(bearer(token)).send({ token: applyToken });

  /** The main export, built once: every upload of it is the same file (same bytes, same hash). */
  let FILE: Buffer;
  // Synthetic export: every rule of the review.
  const ROWS: Array<Partial<NesaRow>> = [
    /* 2 */ { 'School Name': 'GS NGOMA', 'School Code': '220001', Email: 'head.ngoma@example.org', Phone: '0788 555 101' },
    /* 3 */ { 'School Name': 'EP KARAMA', 'School Code': '220002', Cell: 'Butare', Village: 'Gako', 'School Status': 'PRIVATE', Email: 'known@example.org; new.karama@example.org', Phone: 'No Primary' },
    /* 4 */ { 'School Name': 'EP NEW SCHOOL', 'School Code': '220777', Phone: '0722 555 202' },
    /* 5 */ { 'School Name': 'EP KARAMA', 'School Code': '220002', Cell: 'Butare', Village: 'Gako', 'School Status': 'PRIVATE', Email: 'known@example.org; new.karama@example.org', Phone: 'No Primary' },
    /* 6 */ { 'School Name': 'EP DISPUTED ONE', 'School Code': '220500' },
    /* 7 */ { 'School Name': 'EP DISPUTED TWO', 'School Code': '220500' },
    /* 8 */ { 'School Name': 'EP WRONG PROVINCE', 'School Code': '120009' },
    /* 9 */ { 'School Name': 'EP KACYIRU NEW', 'School Code': 'N/A', Province: 'Kigali City', District: 'Gasabo', Sector: 'Kacyiru' },
    /* 10 */ { 'School Name': '' },
    /* 11 */ { 'School Name': 'EP TUMBA NSHYA', Sector: 'Tumba Nshya', 'School Code': 'SDMS CODE: 340209' },
    /* 12 */ { 'School Name': 'Test School', 'School Code': '-' },
    /* 13 */ { 'School Name': 'EP TOTALLY DIFFERENT', 'School Code': '110001', Province: 'Kigali City', District: 'Nyarugenge', Sector: 'Muhima' },
  ];

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
    ngoma = await official('GS NGOMA — Huye', '220001', RW);
    karama = await official('EP KARAMA', '220002', RW);
    missing = await official('ES NOT IN THE FILE', '220003', { ...RW, sector: 'Tumba' });
    kacyiru = await official('GS KACYIRU', '110001', { province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' });
    legacy = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    await p().schoolContact.create({ data: { schoolId: karama, type: 'EMAIL', value: 'known@example.org' } });
    await p().schoolEducationLevel.create({ data: { schoolId: karama, levelCode: 'PR' } });
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'HEAD_COACH' | 'SUPER_ADMIN') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
    teacherId = await mk('sa2.teacher', 'TEACHER');
    await mk('sa2.head', 'HEAD_COACH');
    superAdminId = await mk('sa2.super', 'SUPER_ADMIN');
    await mk('sa2.super2', 'SUPER_ADMIN');
    [teacher, headCoach, superAdmin, superAdmin2] = await Promise.all(['sa2.teacher', 'sa2.head', 'sa2.super', 'sa2.super2'].map((u) => login(ctx, u)));
    // Relationships that must survive every apply.
    karamaStudent = (await p().user.create({ data: {
      username: 'sa2.student', firstName: 'S', lastName: 'K', email: 'sa2.student@test.local', role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: karama,
    } })).id;
    await p().$transaction((tx) => ctx.app.get(SchoolAffiliationService).claim(tx, {
      studentId: karamaStudent, schoolId: karama, source: 'ADMIN', reason: 'NEW_CLAIM', actor: { actorId: ctx.ids.admin, actorRole: 'ADMIN' },
    }));
    await p().teacherSchoolAssignment.create({ data: { teacherId, schoolId: karama, assignedById: ctx.ids.admin } });
  });
  beforeAll(async () => { FILE = await nesaWorkbook(ROWS.map((r) => nesaRow(r))); });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  // ─── M14 ─────────────────────────────────────────────────────────────────────

  it('M14 (the real SQL): rollback removes only its columns and restores M13\'s guard; re-applying works; the directory is untouched', async () => {
    const before = await checksum();
    const c = await pgClient();
    const cols = async () => (await c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE (table_name = 'SchoolSyncRun' AND column_name IN ('approvedAt', 'approvedById', 'approvedGeneration', 'approvalTokenId')) OR (table_name = 'SchoolSyncChange' AND column_name = 'retiredAt')`)).rows[0].n;
    const guard = async () => (await c.query(`SELECT prosrc FROM pg_proc WHERE proname = 'school_sync_run_guard'`)).rows[0].prosrc as string;
    try {
      await c.query('BEGIN');
      await c.query(M14_ROLLBACK);
      expect(await cols()).toBe(0);
      expect(await guard()).not.toContain('approvedById');
      await c.query(M14);
      expect(await cols()).toBe(5);
      expect(await guard()).toContain('approvedById');
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect(await checksum()).toEqual(before);
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  it('review routes: schools.manage; approve / apply / resolve: Super Admins only — Administrators 403 (backend-enforced)', async () => {
    const fake = '00000000-0000-4000-8000-000000000000';
    const review: Array<[string, string, object?]> = [
      ['get', `${R}/${fake}/review`], ['get', `${R}/${fake}/categories`], ['post', `${R}/${fake}/decisions`, {}],
      ['post', `${R}/${fake}/items/${fake}/proposal`, { action: 'CREATE' }], ['post', `${R}/${fake}/recompare`, {}],
    ];
    const superOnly: Array<[string, string, object?]> = [
      ['post', `${R}/${fake}/approve`, {}], ['post', `${R}/${fake}/apply`, { token: 'x'.repeat(40) }], ['post', `${R}/${fake}/items/${fake}/resolve`, { schoolId: fake }],
    ];
    for (const token of [teacher, headCoach, coach, student]) {
      for (const [m, url, b] of [...review, ...superOnly]) expect([url, (await (http() as any)[m](url).set(bearer(token)).send(b ?? {})).status]).toEqual([url, 403]);
    }
    for (const [m, url, b] of [...review, ...superOnly]) expect([url, (await (http() as any)[m](url).send(b ?? {})).status]).toEqual([url, 401]);
    for (const [m, url, b] of superOnly) expect([url, (await (http() as any)[m](url).set(bearer(admin)).send(b ?? {})).status]).toEqual([url, 403]);
    for (const [m, url, b] of review) expect([url, (await (http() as any)[m](url).set(bearer(admin)).send(b ?? {})).status]).toEqual([url, 404]);
    for (const [m, url, b] of superOnly.slice(0, 1)) expect([url, (await (http() as any)[m](url).set(bearer(superAdmin)).send(b ?? {})).status]).toEqual([url, 404]);
  });

  // ─── Review and apply ──────────────────────────────────────────────────────

  let runId: string;

  it('review: summary counts (outcomes, kinds × decisions, manual review), blockers and who uploaded; nothing approved yet', async () => {
    runId = await upload(FILE);
    const s = (await http().get(`${R}/${runId}/review`).set(bearer(admin)).expect(200)).body;
    expect(s.run).toMatchObject({ status: 'PREVIEW', reviewGeneration: 0, approvalCurrent: false, createdBy: { username: 'admin' }, approvedBy: null, appliedBy: null });
    expect(s.outcomes).toMatchObject({ MATCHED: 2, NEW: 3, CONFLICT: 4, DUPLICATE_ROW: 1, INVALID: 1, POSSIBLE_DUPLICATE: 1, MISSING_FROM_SOURCE: 1 });
    expect(s.manualReview).toEqual({ total: 5, conflicts: 4, possibleDuplicates: 1, byState: { OPEN: 5, PROPOSED: 0, RESOLVED: 0 } });
    expect(s.changes.NAME_RESTORE).toEqual({ PENDING: 1, APPROVED: 0, REJECTED: 0 });
    expect(s.changes.CHANGE).toEqual({ PENDING: 1, APPROVED: 0, REJECTED: 0 });   // karama's ownership
    expect(s.blockers).toEqual([]);
  });

  it('decisions: CHANGE / ADD_CONTACT / NEW_PLACE are individual only; a stale category list is refused; dependencies are enforced and cascade', async () => {
    for (const kind of ['CHANGE', 'ADD_CONTACT', 'NEW_PLACE']) {
      expect(errorCode(await decide(runId, { categories: [{ kind, listDigest: 'a'.repeat(64) }] }))).toBe('NOT_A_CATEGORY_KIND');
    }
    expect(errorCode(await decide(runId, { categories: [{ kind: 'FILL_EMPTY', listDigest: 'a'.repeat(64) }] }))).toBe('CATEGORY_LIST_CHANGED');
    const changes = await changesOf(runId);
    const place = changes.find((c) => c.kind === 'NEW_PLACE');
    const tumbaCreate = changes.find((c) => c.kind === 'CREATE_SCHOOL' && c.item.rowNumber === 11);
    expect(errorCode(await decide(runId, { decisions: [{ changeId: tumbaCreate.id, decision: 'APPROVED' }] }))).toBe('DEPENDENCY_NOT_APPROVED');
    // Categories: places / creations first; Tumba's school and its additions are blocked (its place is pending).
    const res = await approveCategories(runId, ['NAME_RESTORE', 'FILL_EMPTY', 'CREATE_SCHOOL', 'ADD_LEVEL']);
    expect(res.body.blocked.length).toBeGreaterThan(0);
    expect((await changesOf(runId)).find((c) => c.id === tumbaCreate.id).decision).toBe('PENDING');
    // Place, then its school and additions; then reject the place: its dependants return to PENDING.
    await decide(runId, { decisions: [{ changeId: place.id, decision: 'APPROVED' }, { changeId: tumbaCreate.id, decision: 'APPROVED' }] }).expect(200);
    const rejected = await decide(runId, { decisions: [{ changeId: place.id, decision: 'REJECTED' }] }).expect(200);
    expect(rejected.body.reverted).toContain(tumbaCreate.id);
    await decide(runId, { decisions: [{ changeId: place.id, decision: 'APPROVED' }, { changeId: tumbaCreate.id, decision: 'APPROVED' }] }).expect(200);
    await approveCategories(runId, ['ADD_LEVEL']);
    // Contacts one by one: approve some, reject one; reject karama's ownership CHANGE.
    const after = await changesOf(runId);
    const contact = (row: number, field: string) => after.find((c) => c.kind === 'ADD_CONTACT' && c.item.rowNumber === row && c.field === field);
    const ownership = after.find((c) => c.kind === 'CHANGE' && c.field === 'ownership');
    await decide(runId, { decisions: [
      { changeId: contact(2, 'EMAIL').id, decision: 'APPROVED' }, { changeId: contact(2, 'PHONE').id, decision: 'REJECTED' },
      { changeId: contact(3, 'EMAIL').id, decision: 'APPROVED' }, { changeId: contact(4, 'PHONE').id, decision: 'APPROVED' },
      { changeId: ownership.id, decision: 'REJECTED' },
    ], note: 'Checked against the NESA portal' }).expect(200);
    const s = (await http().get(`${R}/${runId}/review`).set(bearer(admin)).expect(200)).body;
    expect(s.run.reviewGeneration).toBeGreaterThan(3);
    expect(s.decidedBy).toEqual([{ id: ctx.ids.admin, username: 'admin' }]);
    expect(s.blockers).toEqual([]);
  });

  it('stale reviews: a later decision, a new approval, another Super Admin, an expired token or a changed directory → refused with zero writes (audited)', async () => {
    const before = await checksum();
    const first = await approveRun(runId);
    // A later decision invalidates the token.
    const pending = (await changesOf(runId)).find((c) => c.decision === 'PENDING' && c.kind === 'ADD_CONTACT');
    await decide(runId, { decisions: [{ changeId: pending.id, decision: 'REJECTED' }] }).expect(200);
    expect((await applyRun(runId, first.token)).body).toMatchObject({ code: 'SYNC_REVIEW_OUTDATED', details: { reason: 'TOKEN_REPLACED' } });
    // A new approval replaces the previous token.
    const second = await approveRun(runId);
    const third = await approveRun(runId);
    expect(errorCode(await applyRun(runId, second.token))).toBe('SYNC_REVIEW_OUTDATED');
    // Another Super Admin cannot use it; a tampered token is invalid.
    expect((await applyRun(runId, third.token, superAdmin2)).body).toMatchObject({ code: 'INVALID_APPROVAL_TOKEN', details: { reason: 'WRONG_USER' } });
    expect(errorCode(await applyRun(runId, third.token.slice(0, -2) + 'xx'))).toBe('INVALID_APPROVAL_TOKEN');
    // An expired token.
    const svc = ctx.app.get(SchoolSyncApplyService);
    const realNow = svc.now;
    svc.now = () => new Date(Date.now() + 31 * 60 * 1000);
    try { expect((await applyRun(runId, third.token)).body).toMatchObject({ code: 'SYNC_REVIEW_OUTDATED', details: { reason: 'TOKEN_EXPIRED' } }); } finally { svc.now = realNow; }
    // The directory changed after the review (an approved FILL_EMPTY's school was edited).
    await http().patch(`/api/v1/admin/schools/${karama}`).set(bearer(admin)).send({ village: 'Edited', reason: 'Edited during review' }).expect(200);
    expect((await applyRun(runId, third.token)).body).toMatchObject({ code: 'SYNC_REVIEW_OUTDATED', details: { reason: 'DIRECTORY_CHANGED' } });
    await http().patch(`/api/v1/admin/schools/${karama}`).set(bearer(admin)).send({ village: null, reason: 'Undo' }).expect(200);
    expect(await p().auditLog.count({ where: { action: 'SCHOOL_SYNC_REFUSED', entityId: runId } })).toBeGreaterThanOrEqual(5);
    expect(await p().auditLog.count({ where: { action: 'SCHOOL_SYNC_TOKEN_INVALIDATED', entityId: runId } })).toBeGreaterThanOrEqual(2);   // the decision; the third approval (the second had no live token to replace)
    const tokenAudit = JSON.stringify(await p().auditLog.findMany({ where: { entityId: runId }, select: { metadata: true } }));
    for (const t of [first.token, second.token, third.token]) expect(tokenAudit).not.toContain(t);   // only ids and hashes
    const now = await checksum();
    expect({ ...now, School: undefined }).toEqual({ ...before, School: undefined });   // only the PATCH and its undo touched School
    expect((await p().school.findUniqueOrThrow({ where: { id: karama } })).village).toBeNull();
    expect((await p().schoolSyncRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('PREVIEW');
  });

  it('an audit failure during apply rolls everything back — directory, source records, audit — and the approval still works afterwards', async () => {
    await http().post(`${R}/${runId}/recompare`).set(bearer(admin)).expect(200);   // the undo above changed the comparison
    const { token } = await approveRun(runId);
    const before = await checksum();
    // The request log (ADMIN_REQUEST, written after every administrative request) is not part of the apply.
    const audits = await p().auditLog.count({ where: { action: { not: 'ADMIN_REQUEST' } } });
    const spy = vi.spyOn(ctx.app.get(AuditService), 'logMany').mockImplementationOnce(async () => { throw new Error('audit unavailable'); });
    expect((await applyRun(runId, token)).status).toBe(500);
    spy.mockRestore();
    expect(await checksum()).toEqual(before);
    expect(await p().auditLog.count({ where: { action: { not: 'ADMIN_REQUEST' } } })).toBe(audits);
    expect((await p().schoolSyncRun.findUniqueOrThrow({ where: { id: runId } })).status).toBe('PREVIEW');
  });

  it('apply: only approved changes, atomic, audited per change; ids and relationships kept; nothing deactivated; source records for every row; external ids; who approved and applied', async () => {
    const { token, tokenId } = await approveRun(runId);
    const claimBefore = await p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: karamaStudent, supersededAt: null } });
    const changes = await changesOf(runId);
    const approvedCount = changes.filter((c) => c.decision === 'APPROVED').length;
    const res = await applyRun(runId, token).expect(200);
    expect(res.body).toMatchObject({ status: 'APPLIED', counts: { schoolsCreated: 3, namesRestored: 1, placesApproved: 1, sourceRecordsCreated: 12 } });
    expect(res.body.metrics).toMatchObject({ durationMs: expect.any(Number), lockWaitMs: expect.any(Number), attempt: 1, memoryPeakMb: expect.any(Number) });

    // Matched schools: approved fields only; the rejected ownership change not applied; never deactivated.
    expect(await p().school.findUniqueOrThrow({ where: { id: ngoma } })).toMatchObject({ name: 'GS NGOMA', nameKey: 'gs ngoma', cell: 'Butare', isActive: true, lastSourceSyncAt: expect.any(Date) });
    expect(await p().school.findUniqueOrThrow({ where: { id: karama } })).toMatchObject({ cell: 'Butare', village: 'Gako', ownership: 'PUBLIC', accommodation: 'DAY', isActive: true });
    expect(await p().school.findUniqueOrThrow({ where: { id: missing } })).toMatchObject({ isActive: true, name: 'ES NOT IN THE FILE', lastSourceSyncAt: null });
    // New schools: OFFICIAL_LIST, created by the Super Admin; the new place exists with them.
    const created = await p().school.findMany({ where: { createdById: superAdminId }, orderBy: { name: 'asc' } });
    expect(created.map((s) => [s.name, s.code, s.source, s.sector])).toEqual([
      ['EP KACYIRU NEW', null, 'OFFICIAL_LIST', 'Kacyiru'], ['EP NEW SCHOOL', '220777', 'OFFICIAL_LIST', 'Ngoma'], ['EP TUMBA NSHYA', null, 'OFFICIAL_LIST', 'Tumba Nshya'],
    ]);
    // Contacts: only approved ones, ADMIN_ONLY and unverified; levels added.
    expect((await p().schoolContact.findMany({ where: { schoolId: ngoma } })).map((c) => [c.type, c.value, c.visibility, c.verifiedAt])).toEqual([['EMAIL', 'head.ngoma@example.org', 'ADMIN_ONLY', null]]);
    expect(await p().schoolContact.count({ where: { schoolId: karama, value: 'new.karama@example.org' } })).toBe(1);
    expect(await p().schoolEducationLevel.count({ where: { schoolId: { in: created.map((s) => s.id) } } })).toBe(3);
    // Ids and relationships kept.
    expect((await p().user.findUniqueOrThrow({ where: { id: karamaStudent } })).schoolId).toBe(karama);
    expect(await p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: karamaStudent, supersededAt: null } })).toEqual(claimBefore);
    expect(await p().teacherSchoolAssignment.count({ where: { teacherId, schoolId: karama, isActive: true } })).toBe(1);
    // Source records: every row (conflicts and invalid rows unlinked); external ids for code and fingerprint, never the disputed code.
    const records = await p().schoolSourceRecord.findMany({ where: { syncRunId: runId }, orderBy: { sourceRef: 'asc' } });
    expect(records).toHaveLength(12);
    expect(records.filter((r) => r.schoolId === null).length).toBe(6);   // rows 6, 7, 8, 10, 12, 13
    const ext = await p().schoolExternalId.findMany();
    expect(ext.filter((e) => e.kind === 'CODE').map((e) => e.externalKey).sort()).toEqual(['220001', '220002', '220777']);
    expect(ext.some((e) => e.externalKey === '220500' || e.externalKey === '110001' || e.externalKey === '120009')).toBe(false);
    // One audit entry per applied change, contact values masked; the summary names the token by id.
    const run = await p().schoolSyncRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run).toMatchObject({ status: 'APPLIED', appliedById: superAdminId, approvedById: superAdminId, approvalTokenId: tokenId });
    const appliedChanges = await p().schoolSyncChange.findMany({ where: { runId, appliedAt: { not: null } } });
    expect(appliedChanges).toHaveLength(approvedCount);
    expect(new Set(appliedChanges.map((c) => c.auditLogId)).size).toBe(approvedCount);
    expect(await p().schoolSyncChange.count({ where: { runId, decision: { not: 'APPROVED' }, appliedAt: { not: null } } })).toBe(0);
    const summary = await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_SYNC_APPLIED', entityId: runId } });
    expect(summary.metadata).toMatchObject({ tokenId, tokenSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const trail = JSON.stringify(await p().auditLog.findMany({ where: { createdAt: { gte: run.appliedAt! } }, select: { metadata: true } }));
    for (const v of ['head.ngoma@example.org', 'new.karama@example.org', '722555202', token]) expect([v, trail.includes(v)]).toEqual([v, false]);
    // Applied runs are final; a second apply is refused.
    expect(errorCode(await applyRun(runId, token))).toBe('RUN_NOT_APPLICABLE');
    expect(errorCode(await decide(runId, { decisions: [] }))).toBe('RUN_NOT_APPLICABLE');
  });

  it('idempotent: the same file again creates no school, source record, contact, level, programme or external id', async () => {
    const before = await checksum();
    const again = await upload(FILE);
    await approveCategories(again, ['NAME_RESTORE', 'FILL_EMPTY', 'CREATE_SCHOOL', 'ADD_LEVEL', 'ADD_PROGRAMME']);
    const { token } = await approveRun(again);
    const res = await applyRun(again, token).expect(200);
    expect(res.body.counts).toMatchObject({ schoolsCreated: 0, sourceRecordsCreated: 0, contactsAdded: 0, levelsAdded: 0, programmeLinks: 0, externalIdsCreated: 0 });
    const after = await checksum();
    for (const t of ['SchoolContact', 'SchoolEducationLevel', 'SchoolProgramme', 'Programme', 'SchoolSourceRecord', 'StudentSchoolAffiliation', 'TeacherSchoolAssignment']) {
      expect([t, after[t]]).toEqual([t, before[t]]);
    }
    expect(after.School.split(':')[0]).toBe(before.School.split(':')[0]);   // same number of schools (only lastSourceSyncAt moved)
  });

  it('resolutions: Administrators propose; only a Super Admin decides; linking recompares and yields ordinary decisions; possible duplicates link only to candidates', async () => {
    const run = await upload(FILE);
    const items = await itemsOf(run);
    const conflict = items.find((i) => i.rowNumber === 6);
    const possible = items.find((i) => i.rowNumber === 12);
    expect(errorCode(await http().post(`${R}/${run}/items/${possible.id}/proposal`).set(bearer(admin)).send({ action: 'LINK', schoolId: kacyiru }))).toBe('NOT_A_CANDIDATE');
    const proposal = await http().post(`${R}/${run}/items/${conflict.id}/proposal`).set(bearer(admin)).send({ action: 'LINK', schoolId: missing, code: '220003' }).expect(200);
    expect(proposal.body.proposal).toEqual({ action: 'LINK', schoolId: missing, code: '220003', note: null });
    const resolve = (await changesOf(run)).find((c) => c.kind === 'RESOLVE_CONFLICT');
    expect(errorCode(await decide(run, { decisions: [{ changeId: resolve.id, decision: 'APPROVED' }] }))).toBe('SUPER_ADMIN_ONLY');
    const decided = await decide(run, { decisions: [{ changeId: resolve.id, decision: 'APPROVED' }] }, superAdmin).expect(200);
    expect(decided.body.recompare).toMatchObject({ reason: 'RESOLUTION_DECIDED', attempt: expect.any(Number) });
    const linked = (await itemsOf(run)).find((i) => i.id === conflict.id);
    expect(linked).toMatchObject({ outcome: 'MATCHED', schoolId: missing, matchedBy: 'REVIEW', conflictState: 'PROPOSED' });
    const fresh = (await changesOf(run)).filter((c) => c.schoolId === missing);
    expect(fresh.map((c) => [c.kind, c.field, c.decision])).toEqual(expect.arrayContaining([['CHANGE', 'name', 'PENDING'], ['CHANGE', 'sector', 'PENDING']]));
    expect(fresh.find((c) => c.field === 'code')).toBeUndefined();   // the school already holds the verified code
    // The other row of the dispute stays a conflict; nothing is merged automatically.
    expect((await itemsOf(run)).find((i) => i.rowNumber === 7).outcome).toBe('CONFLICT');
    const { token } = await approveRun(run);
    await applyRun(run, token).expect(200);
    expect((await itemsOf(run)).find((i) => i.id === conflict.id).conflictState).toBe('RESOLVED');
    expect(await p().school.findUniqueOrThrow({ where: { id: missing } })).toMatchObject({ name: 'ES NOT IN THE FILE', sector: 'Tumba' });   // pending changes not applied
  });

  it('after apply: a Super Admin links an open row — identifiers, source-record link and lastSourceSyncAt only; never a field', async () => {
    const items = await itemsOf(runId);
    const open = items.find((i) => i.rowNumber === 12);   // POSSIBLE_DUPLICATE of the legacy school
    const before = await p().school.findUniqueOrThrow({ where: { id: legacy } });
    expect((await http().post(`${R}/${runId}/items/${open.id}/resolve`).set(bearer(admin)).send({ schoolId: legacy })).status).toBe(403);
    const res = await http().post(`${R}/${runId}/items/${open.id}/resolve`).set(bearer(superAdmin)).send({ schoolId: legacy, note: 'Same school' }).expect(200);
    expect(res.body.externalIds).toEqual([{ kind: 'FINGERPRINT', created: true }]);
    const after = await p().school.findUniqueOrThrow({ where: { id: legacy } });
    expect({ ...after, lastSourceSyncAt: undefined, updatedAt: undefined }).toEqual({ ...before, lastSourceSyncAt: undefined, updatedAt: undefined });
    expect(after.lastSourceSyncAt).toBeInstanceOf(Date);
    expect((await p().schoolSourceRecord.findUniqueOrThrow({ where: { id: res.body.sourceRecordId } }))).toMatchObject({ schoolId: legacy, matchedBy: 'REVIEW' });
    expect(errorCode(await http().post(`${R}/${runId}/items/${open.id}/resolve`).set(bearer(superAdmin)).send({ schoolId: legacy }))).toBe('ALREADY_RESOLVED');
    const disputed = items.find((i) => i.rowNumber === 8);
    expect(errorCode(await http().post(`${R}/${runId}/items/${disputed.id}/proposal`).set(bearer(admin)).send({ action: 'CREATE' }))).toBe('RUN_NOT_APPLICABLE');
  });

  it('supersession: applying a newer run supersedes earlier open runs only — an earlier run is then refused; a later run is never superseded', async () => {
    const older = await upload([{ 'School Name': 'EP ORDER A', 'School Code': '220901' }]);
    const newer = await upload([{ 'School Name': 'EP ORDER A', 'School Code': '220901' }]);
    await approveCategories(newer, ['CREATE_SCHOOL']);
    await applyRun(newer, (await approveRun(newer)).token).expect(200);
    expect(await p().schoolSyncRun.findUniqueOrThrow({ where: { id: older } })).toMatchObject({ status: 'SUPERSEDED', supersededByRunId: newer });
    expect(errorCode(await http().post(`${R}/${older}/approve`).set(bearer(superAdmin)))).toBe('RUN_NOT_APPLICABLE');
    // Older first: it stays APPLIED; the newer one, compared before, is stale until recompared.
    const first = await upload([{ 'School Name': 'EP ORDER B', 'School Code': '220902' }]);
    const second = await upload([{ 'School Name': 'EP ORDER B', 'School Code': '220902' }]);
    await approveCategories(first, ['CREATE_SCHOOL']);
    await approveCategories(second, ['CREATE_SCHOOL']);
    const secondToken = (await approveRun(second)).token;
    await applyRun(first, (await approveRun(first)).token).expect(200);
    expect((await applyRun(second, secondToken)).body).toMatchObject({ code: 'SYNC_REVIEW_OUTDATED', details: { reason: 'DIRECTORY_CHANGED' } });
    await http().post(`${R}/${second}/recompare`).set(bearer(admin)).expect(200);
    await applyRun(second, (await approveRun(second)).token).expect(200);
    expect((await p().schoolSyncRun.findUniqueOrThrow({ where: { id: first } })).status).toBe('APPLIED');
    expect(await p().school.count({ where: { code: '220902' } })).toBe(1);
  });

  it('M14 guard: deleting a user who created, approved and applied runs is allowed (their references become NULL); M14 rollback refuses while approval history exists', async () => {
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const temp = await p().user.create({ data: { username: 'sa2.temp', firstName: 'T', lastName: 'T', email: 'sa2.temp@test.local', role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date() } });
    const tempToken = await login(ctx, 'sa2.temp');
    const run = await upload([{ 'School Name': 'EP TEMP', 'School Code': '220903' }], tempToken);
    await approveCategories(run, ['CREATE_SCHOOL'], tempToken);
    await applyRun(run, (await approveRun(run, tempToken)).token, tempToken).expect(200);
    await p().user.delete({ where: { id: temp.id } });
    expect(await p().schoolSyncRun.findUniqueOrThrow({ where: { id: run } })).toMatchObject({ status: 'APPLIED', createdById: null, approvedById: null, appliedById: null });
    const c = await pgClient();
    try {
      await c.query('BEGIN');
      await expect(c.query(M14_ROLLBACK)).rejects.toThrow(/M14_ROLLBACK_REFUSED: \d+ approved runs/);
      await c.query('ROLLBACK');
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
  });

  it('S2a guarantees hold: dry runs write no directory table; the purge (7 days after apply) clears only staged values', async () => {
    const before = await checksum();
    await upload(FILE);
    expect(await checksum()).toEqual(before);
    const { SchoolSyncService } = await import('../src/schools/sync/school-sync.service.js');
    const svc = ctx.app.get(SchoolSyncService);
    const realNow = svc.now;
    svc.now = () => new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
    try { await svc.expireRuns(); await svc.purgeStaging(); } finally { svc.now = realNow; }
    expect((await p().schoolSyncRun.findUniqueOrThrow({ where: { id: runId } })).stagedPurgedAt).toBeInstanceOf(Date);
    expect(await checksum()).toEqual(before);
  });

  // ─── Concurrency (PostgreSQL in CI) ────────────────────────────────────────

  describe('concurrency', () => {
    const requireConcurrency = async (test: { skip: (note: string) => void }) => {
      if (await servesConcurrentConnections()) return true;
      if (process.env.CI) throw new Error('CI database must serve concurrent connections for this test.');
      test.skip('local single-connection database (prisma dev): runs in CI on PostgreSQL');
      return false;
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const waiting = async (c: pg.Client) => (await c.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`)).rows[0].n as number;
    const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(50); } throw new Error('timed out'); };
    const ready = async (rows: Array<Partial<NesaRow>>) => { const id = await upload(rows); await approveCategories(id, ['CREATE_SCHOOL']); return { id, token: (await approveRun(id)).token }; };

    it('the same run applied twice at once: exactly one applies, the other 409 RUN_NOT_APPLICABLE; written once', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const { id, token } = await ready([{ 'School Name': 'EP TWICE', 'School Code': '220911' }]);
      const results = await Promise.all([applyRun(id, token), applyRun(id, token)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(errorCode(results.find((r) => r.status === 409)!)).toBe('RUN_NOT_APPLICABLE');
      expect(await p().school.count({ where: { code: '220911' } })).toBe(1);
      expect(await p().schoolSourceRecord.count({ where: { syncRunId: id } })).toBe(1);
    });

    it('two runs of one dataset racing: serialised by the exclusive lock; either the newer supersedes the older (older 409), or the older applies and the newer is stale; never both applied and superseded', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const older = await ready([{ 'School Name': 'EP RACE', 'School Code': '220921' }]);
      const newer = await ready([{ 'School Name': 'EP RACE', 'School Code': '220921' }]);
      const [a, b] = await Promise.all([applyRun(older.id, older.token), applyRun(newer.id, newer.token)]);
      const statuses = await p().schoolSyncRun.findMany({ where: { id: { in: [older.id, newer.id] } }, select: { id: true, status: true } });
      const of = (id: string) => statuses.find((s) => s.id === id)!.status;
      if (b.status === 200 && a.status !== 200) {
        expect([of(newer.id), of(older.id), errorCode(a)]).toEqual(['APPLIED', 'SUPERSEDED', 'RUN_NOT_APPLICABLE']);
      } else {
        expect([a.status, of(older.id), errorCode(b), of(newer.id)]).toEqual([200, 'APPLIED', 'SYNC_REVIEW_OUTDATED', 'PREVIEW']);
      }
      expect(await p().school.count({ where: { code: '220921' } })).toBe(1);
    });

    it('a school write in progress (shared lock) holds an apply back, and an apply in progress (exclusive) holds school writes back; claims on its schools do not deadlock', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const watcher = await pgClient();
      try {
        // 1. A PATCH holding the shared lock (waiting on the school's row) → the apply waits.
        const { id, token } = await ready([{ 'School Name': 'EP LOCK ONE', 'School Code': '220931' }]);
        const holder = await pgClient();
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM "School" WHERE "id" = $1 FOR UPDATE`, [kacyiru]);
        const patch = http().patch(`/api/v1/admin/schools/${kacyiru}`).set(bearer(admin)).send({ location: 'Kacyiru, centre' }).then((r) => r.status);
        await until(async () => (await waiting(watcher)) >= 1);
        const apply = applyRun(id, token).then((r) => r.status);
        await until(async () => (await waiting(watcher)) >= 2);
        await holder.query('COMMIT');
        await holder.end();
        expect(await patch).toBe(200);
        expect(await apply).toBe(200);
        // 2. An apply holding the exclusive lock (waiting on a school row held by a student claim's FOR SHARE) → a create waits; no deadlock.
        const second = await ready([{ 'School Name': 'EP LOCK TWO', 'School Code': '220932' }, { 'School Name': 'EP KARAMA', 'School Code': '220002', Village: 'Lock' }]);
        const claim = await pgClient();
        await claim.query('BEGIN');
        await claim.query(`SELECT 1 FROM "School" WHERE "id" = $1 FOR SHARE`, [karama]);
        const applying = applyRun(second.id, second.token).then((r) => r.status);
        await until(async () => (await waiting(watcher)) >= 1);
        const create = http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'EP WAITS', ...RW }).then((r) => r.status);
        await sleep(300);
        await claim.query('COMMIT');
        await claim.end();
        expect([await applying, await create]).toEqual([200, 201]);
      } finally {
        await watcher.end();
      }
    });

    it('recompare: a concurrent change of the run row makes the snapshot stale (40001) — the whole transaction is retried and succeeds; an expired run → 409 RUN_NOT_APPLICABLE', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const id = await upload([{ 'School Name': 'EP RETRY', 'School Code': '220941' }]);
      const watcher = await pgClient();
      const holder = await pgClient();
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE "SchoolSyncRun" SET "comparedAt" = now() WHERE "id" = $1`, [id]);
        const recompare = http().post(`${R}/${id}/recompare`).set(bearer(admin));
        const result = recompare.then((r) => r);
        await until(async () => (await waiting(watcher)) >= 1);
        await holder.query('COMMIT');
        const r = await result;
        expect(r.status).toBe(200);
        expect(r.body.attempt).toBe(2);
        expect(await p().auditLog.count({ where: { action: 'SCHOOL_SYNC_RECOMPARED', entityId: id } })).toBe(1);   // the failed attempt left nothing
        await holder.query('BEGIN');
        await holder.query(`UPDATE "SchoolSyncRun" SET "status" = 'EXPIRED' WHERE "id" = $1`, [id]);
        const expired = http().post(`${R}/${id}/recompare`).set(bearer(admin)).then((x) => x);
        await until(async () => (await waiting(watcher)) >= 1);
        await holder.query('COMMIT');
        expect(errorCode(await expired)).toBe('RUN_NOT_APPLICABLE');
      } finally {
        await holder.end();
        await watcher.end();
      }
    });

    it('a 5,000-school apply finishes within 60 s (one transaction), with its metrics recorded', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const rows = Array.from({ length: 5000 }, (_, i) => ({ 'School Name': `EP SCALE APPLY ${i}`, 'School Code': String(225_000 + i), Village: `V${i}`, Email: `scale${i}@example.org` }));
      const id = await upload(rows);
      await approveCategories(id, ['CREATE_SCHOOL', 'ADD_LEVEL', 'FILL_EMPTY']);
      const contacts = (await changesOf(id)).filter((c) => c.kind === 'ADD_CONTACT' && c.field === 'EMAIL').map((c) => ({ changeId: c.id, decision: 'APPROVED' }));
      for (let i = 0; i < contacts.length; i += 500) await decide(id, { decisions: contacts.slice(i, i + 500) }).expect(200);
      const { token } = await approveRun(id);
      const started = Date.now();
      const res = await applyRun(id, token).expect(200);
      const ms = Date.now() - started;
      console.log(`S2b apply, 5,000 schools: ${ms} ms; metrics ${JSON.stringify(res.body.metrics)}`);
      expect(ms).toBeLessThan(60_000);
      expect(res.body.counts).toMatchObject({ schoolsCreated: 5000, sourceRecordsCreated: 5000, contactsAdded: 5000 });
      expect((await p().schoolSyncRun.findUniqueOrThrow({ where: { id } })).metrics).toMatchObject({ durationMs: expect.any(Number), memoryPeakMb: expect.any(Number) });
    }, 300_000);
  });
});
