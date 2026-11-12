/**
 * School administration PR B — school records (owner-approved 2026-11-11).
 *
 *   M11: country, active flag, source (OFFICIAL_LIST / ADMIN / LEGACY), creator, updatedAt —
 *        additive, ids and relationships unchanged; rollback and re-apply.
 *   /admin/schools (schools.manage): list, get, students, create, edit, deactivate / reactivate,
 *        every change atomic with its audit record.
 *   Creation rules: Rwanda (official directory place; optional code whose first digit is the
 *        province) or another country (ISO 3166-1 alpha-2, location, never a code); unique code;
 *        names may repeat (school directory S1, M12) — possible duplicates (same name nearby) need
 *        an explicit, audited confirmation.
 *   Inactive schools: no new registration, claim, verification, invitation, CSV row or Teacher
 *        assignment; every existing record and Teacher access kept; reactivation restores.
 *   Invitations and CSV imports never create a school; a name alone, a mismatching name, an
 *        unknown or inactive school are refused (row errors in CSV, dry run too).
 *   Concurrency (PostgreSQL in CI): name / code races, and deactivation vs every new use.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

import { AuditService } from '../src/audit/audit.service.js';
import { PERMISSIONS, ROLE_GRANTS, ROLE_PERMISSIONS } from '../src/auth/permissions.js';
import { SchoolAffiliationService } from '../src/schools/affiliations/school-affiliation.service.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const ROOT = join(__dirname, '..');
/** A migration or rollback file without its BEGIN/COMMIT, to run inside a test's own transaction. */
const body = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n').split('\n')
  .filter((l) => !/^(BEGIN|COMMIT);$/.test(l.trim())).join('\n');
const M11 = body('prisma/migrations/20261121001000_school_administration/migration.sql');
const M11_BACKFILL = M11.slice(M11.indexOf('-- BACKFILL BEGIN'), M11.indexOf('-- BACKFILL END'));
const M11_ROLLBACK = body('docs/migrations/20261121001000_school_administration.rollback.sql');

/** True when the database serves another connection while a transaction is open (PostgreSQL yes; `prisma dev` no). */
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

describe('School administration (PR B)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, teacher: string, headCoach: string, coach: string, student: string;
  let teacherId: string, legacy: string, officialSouth: string, officialKigali: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const S = '/api/v1/admin/schools';
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const audits = (action: string, entityId?: string) => p().auditLog.count({ where: { action, ...(entityId && { entityId }) } });
  const RW = { province: 'Southern Province', district: 'Huye', sector: 'Ngoma' };
  let seq = 0;

  /** An activated, approved student at a school, with a PENDING claim made through the service. */
  const mkStudent = async (schoolId: string) => {
    const n = ++seq;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const u = await p().user.create({ data: {
      username: `sa.s${n}`, firstName: 'Sa', lastName: `S${n}`, email: `sa.s${n}@test.local`, role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId,
    } });
    await p().$transaction((tx) => ctx.app.get(SchoolAffiliationService).claim(tx, {
      studentId: u.id, schoolId, source: 'ADMIN', reason: 'NEW_CLAIM', actor: { actorId: ctx.ids.admin, actorRole: 'ADMIN' },
    }));
    return u.id;
  };
  const claimOf = async (studentId: string) => p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId, supersededAt: null } });
  const verify = async (studentId: string) =>
    http().post(`/api/v1/admin/school-affiliations/${(await claimOf(studentId)).id}/verify`).set(bearer(admin)).send({}).expect(200);
  const create = (body: object, token = admin) => http().post(S).set(bearer(token)).send(body);
  const setActive = (id: string, isActive: boolean, token = admin) => http().patch(`${S}/${id}/active`).set(bearer(token)).send({ isActive, reason: 'Test reason' });
  const register = (username: string, extra: object) => http().post('/api/v1/auth/register/student').send({
    firstName: 'R', lastName: username, username, email: `${username}@test.local`, password: 'Secret123', gradeLevel: 'S2', homeLocation: 'Huye', ...extra,
  });
  const invite = (email: string, extra: object) => http().post('/api/v1/admin/users/invite').set(bearer(admin)).send({
    firstName: 'I', lastName: 'Nv', email, gradeLevel: 'S2', ...extra,
  });
  const csvImport = (rows: string[], dryRun: boolean) => http().post('/api/v1/admin/users/import').query({ dryRun }).set(bearer(admin))
    .attach('file', Buffer.from(rows.join('\r\n'), 'utf8'), { filename: 'u.csv', contentType: 'text/csv' });

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    student = await login(ctx, 'student.j');
    legacy = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;   // seeded without a code → LEGACY
    // The official directory (a part of it): places for Rwandan schools.
    officialSouth = (await p().school.create({ data: {
      name: 'GS Ngoma Official', code: '220001', location: 'Ngoma, Huye', ...RW, ownership: 'PUBLIC', nameKey: 'gs ngoma official', source: 'OFFICIAL_LIST',
    } })).id;
    officialKigali = (await p().school.create({ data: {
      name: 'GS Kacyiru Official', code: '110001', location: 'Kacyiru, Gasabo', province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru',
      ownership: 'PUBLIC', nameKey: 'gs kacyiru official', source: 'OFFICIAL_LIST',
    } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'HEAD_COACH' | 'SUPER_ADMIN') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
    teacherId = await mk('sa.teacher', 'TEACHER');
    await mk('sa.head', 'HEAD_COACH');
    await mk('sa.super', 'SUPER_ADMIN');
    [teacher, headCoach, superAdmin] = await Promise.all(['sa.teacher', 'sa.head', 'sa.super'].map((u) => login(ctx, u)));
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  // ─── M11 ─────────────────────────────────────────────────────────────────────

  it('M11 (the real SQL): coded schools → OFFICIAL_LIST, others LEGACY; ids and every relationship unchanged; idempotent; rollback drops only its objects, leaves the history, and re-applying works', async () => {
    const s = await mkStudent(officialSouth);
    await p().teacherSchoolAssignment.create({ data: { teacherId, schoolId: officialSouth, assignedById: ctx.ids.admin } });
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
    const links = () => q(`SELECT (SELECT json_agg(json_build_object('id', "id", 'name', "name", 'code', "code") ORDER BY "id") FROM "School") AS schools,
                                  (SELECT json_agg(json_build_object('u', "id", 's', "schoolId") ORDER BY "id") FROM "User") AS users,
                                  (SELECT json_agg(json_build_object('a', "id", 's', "schoolId", 'st', "status") ORDER BY "id") FROM "StudentSchoolAffiliation") AS claims,
                                  (SELECT json_agg(json_build_object('e', "id", 's', "schoolId") ORDER BY "id") FROM "StudentEnrollment") AS enrolments,
                                  (SELECT json_agg(json_build_object('t', "id", 's', "schoolId") ORDER BY "id") FROM "TeacherSchoolAssignment") AS teachers`);
    const columns = async () => (await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'School'
      AND column_name IN ('countryCode', 'isActive', 'source', 'createdById', 'updatedAt')`))[0].n;
    try {
      const before = await links();
      await c.query('BEGIN');
      await c.query(M11_ROLLBACK);
      expect(await columns()).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'SchoolSource'`))[0].n).toBe(0);
      expect((await q(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '20261121001000_school_administration'`))[0].n).toBe(1);
      expect(await links()).toEqual(before);

      await c.query(M11);
      expect(await columns()).toBe(5);
      const rows = await q(`SELECT "id", "source"::text AS source, "countryCode", "isActive", "createdById" FROM "School" WHERE "id" = ANY($1)`, [[legacy, officialSouth, officialKigali]]);
      expect(Object.fromEntries(rows.map((r) => [r.id, [r.source, r.countryCode, r.isActive, r.createdById]]))).toEqual({
        [legacy]: ['LEGACY', 'RW', true, null], [officialSouth]: ['OFFICIAL_LIST', 'RW', true, null], [officialKigali]: ['OFFICIAL_LIST', 'RW', true, null],
      });
      expect(await links()).toEqual(before);
      const summaries = async () => (await q(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "action" = 'SCHOOL_SOURCE_BACKFILL'`))[0].n;
      expect(await summaries()).toBe(1);
      await c.query(M11_BACKFILL);   // idempotent: nothing more to change, no second summary
      expect(await summaries()).toBe(1);
      await c.query('ROLLBACK');
      expect(await columns()).toBe(5);   // nothing persisted
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      await c.end();
    }
    expect((await claimOf(s)).schoolId).toBe(officialSouth);
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  it('schools.manage only: Administrators and Super Admins; Teachers, Head Coaches, Coaches and Students 403, anonymous 401; the deprecated GET /schools aliases keep their guard', async () => {
    const target = officialKigali;
    const routes: Array<[string, string, object?]> = [
      ['get', S], ['get', `${S}/${target}`], ['get', `${S}/${target}/students`],
      ['post', S, { name: 'Nope School', ...RW }], ['patch', `${S}/${target}`, { location: 'Nope' }], ['patch', `${S}/${target}/active`, { isActive: false, reason: 'nope' }],
    ];
    for (const token of [teacher, headCoach, coach, student]) {
      for (const [m, url, b] of routes) expect([m, url, await status((http() as any)[m](url).set(bearer(token)).send(b ?? {}))]).toEqual([m, url, [403, expect.any(String)]]);
    }
    for (const [m, url, b] of routes) expect([m, url, (await (http() as any)[m](url).send(b ?? {})).status]).toEqual([m, url, 401]);
    for (const token of [admin, superAdmin]) {
      await http().get(S).set(bearer(token)).expect(200);
      await http().get(`${S}/${target}`).set(bearer(token)).expect(200);
      await http().get(`${S}/${target}/students`).set(bearer(token)).expect(200);
    }
    expect(await p().school.count({ where: { name: 'Nope School' } })).toBe(0);
    for (const token of [admin, superAdmin]) await http().get('/api/v1/schools').set(bearer(token)).expect(200);
    for (const token of [teacher, headCoach, coach, student]) expect((await http().get('/api/v1/schools').set(bearer(token))).status).toBe(403);
  });

  it('GET /me/permissions matches what the backend allows: ADMIN reports schools.manage (and reaches /admin/schools) but never schools.syncDirectory (approve / apply / resolve 403); SUPER_ADMIN keeps both', async () => {
    const perms = async (token: string) => (await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200)).body.permissions as string[];
    const adminPerms = await perms(admin);
    expect(adminPerms).toContain('schools.manage');
    expect(adminPerms).not.toContain('schools.syncDirectory');
    expect(adminPerms).toEqual(ROLE_PERMISSIONS.ADMIN);
    await http().get(S).set(bearer(admin)).expect(200);

    const superPerms = await perms(superAdmin);
    expect(superPerms).toEqual(expect.arrayContaining(['schools.manage', 'schools.syncDirectory', 'permissions.manageOverrides', 'settings.manageSystem']));
    expect(superPerms).toEqual(PERMISSIONS.filter((x) => Object.hasOwn(ROLE_GRANTS.SUPER_ADMIN, x)));

    const R = '/api/v1/admin/school-sync/runs';
    const fake = '00000000-0000-4000-8000-000000000000';
    const syncOnly: Array<[string, object]> = [
      [`${R}/${fake}/approve`, {}], [`${R}/${fake}/apply`, { token: 'x'.repeat(40) }], [`${R}/${fake}/items/${fake}/resolve`, { schoolId: fake }],
    ];
    for (const [url, body] of syncOnly) {
      expect([url, (await http().post(url).set(bearer(admin)).send(body)).status]).toEqual([url, 403]);
      expect([url, (await http().post(url).set(bearer(superAdmin)).send(body)).status]).not.toEqual([url, 403]);
    }
  });

  // ─── Create ────────────────────────────────────────────────────────────────

  describe('create', () => {
    it('Rwanda with a code: ADMIN source, creator, default location, normalised key, audited in the same transaction', async () => {
      const res = await create({ name: '  Lycée   de Ngoma ', code: '220777', ...RW, ownership: 'PRIVATE' }).expect(201);
      expect(res.body).toMatchObject({
        name: 'Lycée de Ngoma', code: '220777', countryCode: 'RW', ...RW, location: 'Ngoma, Huye', ownership: 'PRIVATE',
        source: 'ADMIN', isActive: true, createdBy: { id: ctx.ids.admin },
      });
      expect((await p().school.findUniqueOrThrow({ where: { id: res.body.id } })).nameKey).toBe('lycee de ngoma');
      const log = await p().auditLog.findFirstOrThrow({ where: { action: 'CREATE_SCHOOL', entityId: res.body.id } });
      expect(log).toMatchObject({ actorId: ctx.ids.admin, entity: 'School' });
      expect(log.metadata).toMatchObject({ school: { name: 'Lycée de Ngoma', code: '220777', source: 'ADMIN' } });
      // Without a code, too.
      expect((await create({ name: 'Ngoma Community School', ...RW }).expect(201)).body).toMatchObject({ code: null, source: 'ADMIN' });
    });

    it('validation: code format and province prefix, the directory place, required fields, control characters', async () => {
      const bad = async (b: object) => (await status(create(b)));
      expect(await bad({ name: 'Bad Code A', code: '22077', ...RW })).toEqual([400, 'VALIDATION_FAILED']);
      expect(await bad({ name: 'Bad Code B', code: '120777', ...RW })).toEqual([400, 'INVALID_SCHOOL']);   // 1 = Kigali City, not Southern
      expect(await bad({ name: 'Bad Code C', code: '920777', ...RW })).toEqual([400, 'INVALID_SCHOOL']);
      expect(await bad({ name: 'Bad Place', province: 'Southern Province', district: 'Huye', sector: 'Nowhere' })).toEqual([400, 'UNKNOWN_SCHOOL_LOCATION']);
      expect(await bad({ name: 'No Place' })).toEqual([400, 'INVALID_SCHOOL']);
      expect(await bad({ name: 'Bad\u0007Name', ...RW })).toEqual([400, 'VALIDATION_FAILED']);
      expect(await bad({ name: '!!', ...RW })).toEqual([400, 'INVALID_SCHOOL_NAME']);
      expect(await p().school.count({ where: { name: { startsWith: 'Bad' } } })).toBe(0);
    });

    it('another country: ISO 3166-1 alpha-2, a location, never a code or a Rwandan place; never offered by the Rwanda directory or registration matching', async () => {
      const ke = await create({ name: 'Nairobi School', countryCode: 'ke', location: 'Nairobi' }).expect(201);
      expect(ke.body).toMatchObject({ countryCode: 'KE', code: null, province: null, district: null, sector: null, location: 'Nairobi', source: 'ADMIN' });
      expect(await status(create({ name: 'Kampala School', countryCode: 'UG' }))).toEqual([400, 'INVALID_SCHOOL']);
      expect(await status(create({ name: 'Kampala School', countryCode: 'UG', location: 'Kampala', code: '220778' }))).toEqual([400, 'SCHOOL_CODE_RWANDA_ONLY']);
      expect(await status(create({ name: 'Kampala School', countryCode: 'UG', location: 'Kampala', ...RW }))).toEqual([400, 'SCHOOL_DIRECTORY_RWANDA_ONLY']);
      expect(await status(create({ name: 'Kampala School', countryCode: 'XX', location: 'Kampala' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(create({ name: 'Kampala School', countryCode: 'UGA', location: 'Kampala' }))).toEqual([400, 'VALIDATION_FAILED']);
      // Not in the public (Rwanda) directory; a Rwandan registration naming it is not linked to it.
      expect((await http().get('/api/v1/schools/search').query({ q: 'Nairobi' }).expect(200)).body).toEqual([]);
      await register('sa.reg.nairobi', { schoolName: 'Nairobi School' }).expect(201);
      expect((await p().user.findUniqueOrThrow({ where: { username: 'sa.reg.nairobi' } })).schoolId).toBeNull();
      // And it cannot be invited to by a code (it has none) — only by id.
      await invite('sa.inv.ke@test.local', { schoolId: ke.body.id }).expect(201);
    });

    it('the code is unique (409); a name is not (M12): the same name in the same district is a possible duplicate, in another district simply another school', async () => {
      expect(await status(create({ name: 'GS Ngoma Official', ...RW }))).toEqual([409, 'POSSIBLE_DUPLICATE']);
      const elsewhere = await create({ name: 'GS Ngoma Official', province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' }).expect(201);
      expect(elsewhere.body).toMatchObject({ name: 'GS Ngoma Official', district: 'Gasabo', code: null });
      expect(await p().school.count({ where: { name: 'GS Ngoma Official' } })).toBe(2);
      expect((await p().school.findUniqueOrThrow({ where: { id: officialSouth } })).name).toBe('GS Ngoma Official');   // untouched
      expect(await status(create({ name: 'Another Ngoma', code: '220001', ...RW }))).toEqual([409, 'SCHOOL_CODE_TAKEN']);
    });

    it('possible duplicates: the same normalised name in the same district (or with no district) / country → 409 with candidates, unless confirmed — and the confirmation is audited', async () => {
      const first = await create({ name: 'Lycée de Huye', ...RW }).expect(201);
      const dup = await create({ name: 'LYCEE DE HUYE!', ...RW }).expect(409);
      expect(dup.body).toMatchObject({ code: 'POSSIBLE_DUPLICATE', details: { candidates: [expect.objectContaining({ id: first.body.id, name: 'Lycée de Huye' })] } });
      const confirmed = await create({ name: 'LYCEE DE HUYE!', ...RW, confirmPossibleDuplicate: true }).expect(201);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'CREATE_SCHOOL', entityId: confirmed.body.id } })).metadata)
        .toMatchObject({ confirmedPossibleDuplicate: true, possibleDuplicates: [first.body.id] });
      // Another district: not a duplicate.
      await create({ name: 'Lycée de Huye.', province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' }).expect(201);
      // A legacy school (no district recorded) with the same normalised name counts.
      expect(await status(create({ name: 'TEST-SCHOOL', ...RW }))).toEqual([409, 'POSSIBLE_DUPLICATE']);
      // Abroad: same country → duplicate; another country → not.
      await create({ name: 'Alliance High School', countryCode: 'KE', location: 'Kikuyu' }).expect(201);
      expect(await status(create({ name: 'Alliance High-School', countryCode: 'KE', location: 'Nairobi' }))).toEqual([409, 'POSSIBLE_DUPLICATE']);
      await create({ name: 'Alliance High-School', countryCode: 'UG', location: 'Kampala' }).expect(201);
    });
  });

  // ─── Edit ──────────────────────────────────────────────────────────────────

  describe('edit', () => {
    it('rename / recode keep the id: students, claims (VERIFIED stays VERIFIED), enrolments and Teacher access unchanged; every change audited from → to', async () => {
      const school = (await create({ name: 'Edit Me School', ...RW }).expect(201)).body.id;
      const s = await mkStudent(school);
      await verify(s);
      const claim = await claimOf(s);
      await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: school }).expect(201);
      const listed = async () => (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data.map((x: any) => x.id);
      expect(await listed()).toContain(s);

      const res = await http().patch(`${S}/${school}`).set(bearer(admin)).send({ name: 'Edited School', location: 'Ngoma centre', code: '220555', reason: 'Official code assigned' }).expect(200);
      expect(res.body).toMatchObject({ id: school, name: 'Edited School', code: '220555', location: 'Ngoma centre' });
      expect((await p().school.findUniqueOrThrow({ where: { id: school } })).nameKey).toBe('edited school');
      expect(await claimOf(s)).toMatchObject({ id: claim.id, status: 'VERIFIED', schoolId: school });
      expect((await p().user.findUniqueOrThrow({ where: { id: s } })).schoolId).toBe(school);
      expect(await listed()).toContain(s);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'UPDATE_SCHOOL', entityId: school } })).metadata).toMatchObject({
        changes: { name: { from: 'Edit Me School', to: 'Edited School' }, code: { from: null, to: '220555' }, location: { from: 'Ngoma, Huye', to: 'Ngoma centre' } },
        reason: 'Official code assigned',
      });
      expect(await audits('SCHOOL_AFFILIATION_SUPERSEDED', claim.id)).toBe(0);
    });

    it('rules: a code change needs a reason, a code is never removed, conflicts 409, official-directory changes need a reason, no-op 400, a legacy school can be renamed without a place', async () => {
      const school = (await create({ name: 'Rules School', code: '220556', ...RW }).expect(201)).body.id;
      const patch = (id: string, b: object) => status(http().patch(`${S}/${id}`).set(bearer(admin)).send(b));
      expect(await patch(school, { code: '220557' })).toEqual([400, 'REASON_REQUIRED']);
      expect(await patch(school, { code: '120557', reason: 'typo' })).toEqual([400, 'INVALID_SCHOOL']);
      expect(await patch(school, { code: null, reason: 'remove' })).toEqual([400, 'VALIDATION_FAILED']);
      expect(await patch(school, { code: '220001', reason: 'clash' })).toEqual([409, 'SCHOOL_CODE_TAKEN']);
      expect(await patch(school, { name: 'GS Ngoma Official' })).toEqual([409, 'POSSIBLE_DUPLICATE']);   // same name, same district (M12: not unique)
      expect(await patch(school, { name: 'Rules School' })).toEqual([400, 'NO_CHANGES']);
      expect(await patch(school, { countryCode: 'KE', location: 'Nairobi' })).toEqual([400, 'SCHOOL_CODE_RWANDA_ONLY']);
      expect(await patch(officialKigali, { name: 'Renamed Official' })).toEqual([400, 'REASON_REQUIRED']);
      await http().patch(`${S}/${officialKigali}`).set(bearer(admin)).send({ location: 'Kacyiru, near the stadium' }).expect(200);   // location only: no reason needed
      await http().patch(`${S}/${legacy}`).set(bearer(admin)).send({ name: 'Test School (legacy)', location: 'Kigali, Nyarugenge' }).expect(200);   // a real rename; no place, no reason needed
      expect(await p().school.findUniqueOrThrow({ where: { id: legacy } })).toMatchObject({ name: 'Test School (legacy)', nameKey: 'test school legacy', province: null, source: 'LEGACY' });
      expect((await p().school.findUniqueOrThrow({ where: { id: school } })).code).toBe('220556');
    });
  });

  // ─── Deactivate / reactivate ───────────────────────────────────────────────

  describe('deactivation', () => {
    let school: string, verifiedStudent: string, pendingStudent: string;

    beforeAll(async () => {
      school = (await create({ name: 'Closing School', code: '220900', ...RW }).expect(201)).body.id;
      verifiedStudent = await mkStudent(school);
      await verify(verifiedStudent);
      pendingStudent = await mkStudent(school);
      await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: school }).expect(201);
    });

    it('reports what refers to the school, warns, is audited; repeating it changes nothing', async () => {
      const res = await setActive(school, false).expect(200);
      expect(res.body).toMatchObject({
        changed: true, school: { id: school, isActive: false },
        impact: { students: 2, verifiedStudents: 1, pendingClaims: 1, activeTeacherAssignments: 1 },
        warning: expect.stringMatching(/kept/),
      });
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_DEACTIVATED', entityId: school } })).metadata)
        .toMatchObject({ reason: 'Test reason', previous: { isActive: true }, next: { isActive: false }, impact: { verifiedStudents: 1 } });
      expect((await setActive(school, false).expect(200)).body).toMatchObject({ changed: false });
      expect(await audits('SCHOOL_DEACTIVATED', school)).toBe(1);
      expect(await status(http().patch(`${S}/${school}/active`).set(bearer(admin)).send({ isActive: true }))).toEqual([400, 'VALIDATION_FAILED']);   // reason required
    });

    it('keeps every existing record and Teacher access', async () => {
      expect(await claimOf(verifiedStudent)).toMatchObject({ status: 'VERIFIED', schoolId: school });
      expect(await claimOf(pendingStudent)).toMatchObject({ status: 'PENDING', schoolId: school });
      expect(await p().teacherSchoolAssignment.count({ where: { schoolId: school, isActive: true } })).toBe(1);
      const listed = (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data.map((x: any) => x.id);
      expect(listed).toContain(verifiedStudent);
      await http().get(`/api/v1/admin/users/${verifiedStudent}`).set(bearer(admin)).expect(200);
      // Re-sending a student's current (inactive) school creates no claim, so it is accepted.
      await http().patch(`/api/v1/admin/users/${verifiedStudent}`).set(bearer(admin)).send({ schoolId: school, firstName: 'Kept' }).expect(200);
      expect(await claimOf(verifiedStudent)).toMatchObject({ status: 'VERIFIED' });
      // The school list still shows it (inactive), with its counts.
      const row = (await http().get(S).query({ isActive: false, limit: 100 }).set(bearer(admin)).expect(200)).body.data.find((x: any) => x.id === school);
      expect(row).toMatchObject({ isActive: false, students: 2, verifiedStudents: 1 });
    });

    it('refuses every NEW use: public directory, registration, Administrator create / move, invitation, CSV row (dry run too), verification, Teacher assignment — nothing is written', async () => {
      const users = await p().user.count();
      const claims = await p().studentSchoolAffiliation.count();
      expect((await http().get('/api/v1/schools/search').query({ q: 'Closing' }).expect(200)).body).toEqual([]);
      expect(JSON.stringify((await http().get('/api/v1/schools/locations').expect(200)).body)).not.toContain('Closing');
      expect(await status(register('sa.reg.closed', { schoolCode: '220900' }))).toEqual([409, 'SCHOOL_INACTIVE']);
      expect(await status(http().post('/api/v1/admin/users').set(bearer(admin)).send({
        firstName: 'C', lastName: 'Closed', username: 'sa.create.closed', email: 'sa.create.closed@test.local', password: 'Str0ng!Passw0rd', role: 'STUDENT', gradeLevel: 'S2', schoolCode: '220900',
      }))).toEqual([409, 'SCHOOL_INACTIVE']);
      const elsewhere = await mkStudent(officialSouth);
      const claimsWithMover = await p().studentSchoolAffiliation.count();
      expect(await status(http().patch(`/api/v1/admin/users/${elsewhere}`).set(bearer(admin)).send({ schoolId: school }))).toEqual([409, 'SCHOOL_INACTIVE']);
      expect((await p().user.findUniqueOrThrow({ where: { id: elsewhere } })).schoolId).toBe(officialSouth);
      expect(await status(invite('sa.inv.closed@test.local', { schoolCode: '220900' }))).toEqual([409, 'SCHOOL_INACTIVE']);
      for (const dryRun of [true, false]) {
        const res = await csvImport(['firstName,lastName,email,role,gradeLevel,schoolCode', 'Csv,Closed,sa.csv.closed@test.local,STUDENT,S2,220900'], dryRun).expect(200);
        expect(res.body).toMatchObject({ created: 0, failed: 1 });
        expect(res.body.errors[0].errors.join()).toMatch(/inactive/);
      }
      expect(await status(http().post(`/api/v1/admin/school-affiliations/${(await claimOf(pendingStudent)).id}/verify`).set(bearer(admin)).send({}))).toEqual([409, 'SCHOOL_INACTIVE']);
      const teacher2 = (await p().user.create({ data: { username: 'sa.teacher2', firstName: 'T2', lastName: 'T', email: 'sa.teacher2@test.local', role: 'TEACHER', activatedAt: new Date() } })).id;
      expect(await status(http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: teacher2, schoolId: school }))).toEqual([409, 'SCHOOL_INACTIVE']);
      // Ending the existing assignment is allowed; re-activating it is a new use → refused.
      const assignment = await p().teacherSchoolAssignment.findFirstOrThrow({ where: { teacherId, schoolId: school } });
      await http().delete(`/api/v1/admin/teacher-assignments/${assignment.id}`).set(bearer(admin)).expect(200);
      expect(await status(http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: school }))).toEqual([409, 'SCHOOL_INACTIVE']);
      expect(await p().user.count()).toBe(users + 2);   // only the fixture mover and teacher2
      expect(await p().studentSchoolAffiliation.count()).toBe(claimsWithMover);
      expect(claimsWithMover).toBe(claims + 1);
      // Rejecting a pending claim at an inactive school is still allowed.
      await http().post(`/api/v1/admin/school-affiliations/${(await claimOf(pendingStudent)).id}/reject`).set(bearer(admin)).send({ reason: 'School closed' }).expect(200);
    });

    it('reactivation restores eligibility without rewriting history', async () => {
      const verifiedClaim = await claimOf(verifiedStudent);
      const res = await setActive(school, true).expect(200);
      expect(res.body).toMatchObject({ changed: true, school: { isActive: true } });
      expect(res.body.warning).toBeUndefined();
      expect(await audits('SCHOOL_REACTIVATED', school)).toBe(1);
      expect(await claimOf(verifiedStudent)).toMatchObject({ id: verifiedClaim.id, status: 'VERIFIED' });
      expect((await http().get('/api/v1/schools/search').query({ q: 'Closing' }).expect(200)).body).toEqual([expect.objectContaining({ id: school })]);
      await register('sa.reg.reopened', { schoolCode: '220900' }).expect(201);
      expect(await claimOf((await p().user.findUniqueOrThrow({ where: { username: 'sa.reg.reopened' } })).id)).toMatchObject({ schoolId: school, status: 'PENDING' });
      await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: school }).expect(201);
    });
  });

  // ─── Invitations, CSV import, Administrator create / edit ──────────────────

  describe('invitations and CSV import never create a school', () => {
    it('invitation: a name alone is refused (school count unchanged, no account, no audit); by code or id → PENDING claim; mismatches refused', async () => {
      const schools = await p().school.count();
      const users = await p().user.count();
      const invites = await audits('INVITE_USER');
      const nameOnly = await invite('sa.inv.name@test.local', { schoolName: 'Brand New School', schoolLocation: 'Huye' }).expect(400);
      expect(nameOnly.body).toMatchObject({ code: 'SCHOOL_REFERENCE_REQUIRED' });
      expect(await status(invite('sa.inv.unknown@test.local', { schoolCode: '229999' }))).toEqual([400, 'UNKNOWN_SCHOOL_CODE']);
      expect(await status(invite('sa.inv.mix@test.local', { schoolCode: '220001', schoolId: officialKigali }))).toEqual([400, 'SCHOOL_REFERENCE_MISMATCH']);
      expect(await status(invite('sa.inv.wrong@test.local', { schoolCode: '220001', schoolName: 'GS Kacyiru Official' }))).toEqual([400, 'SCHOOL_NAME_MISMATCH']);
      expect(await p().school.count()).toBe(schools);
      expect(await p().user.count()).toBe(users);
      expect(await audits('INVITE_USER')).toBe(invites);

      const ok = await invite('sa.inv.ok@test.local', { schoolCode: '220001', schoolName: 'gs ngoma OFFICIAL' }).expect(201);
      expect(await claimOf(ok.body.user.id)).toMatchObject({ schoolId: officialSouth, status: 'PENDING', source: 'ADMIN' });
      expect(await p().school.count()).toBe(schools);
    });

    it('CSV import: name-only, unknown code, name/code mismatch are row errors (dry run and import); valid rows by code or id; no school is ever created', async () => {
      const rows = [
        'firstName,lastName,email,role,gradeLevel,schoolCode,schoolId,schoolName,schoolLocation',
        'Code,Ok,sa.csv.code@test.local,STUDENT,S2,220001,,,',
        `Id,Ok,sa.csv.id@test.local,STUDENT,S2,,${officialKigali},,`,
        'Name,Only,sa.csv.name@test.local,STUDENT,S2,,,Brand New School,Huye',
        'Code,Unknown,sa.csv.unknown@test.local,STUDENT,S2,229998,,,',
        'Name,Mismatch,sa.csv.mismatch@test.local,STUDENT,S2,220001,,GS Kacyiru Official,',
        'Coach,NoSchool,sa.csv.coach@test.local,MENTOR,,,,,',
      ];
      const schools = await p().school.count();
      for (const dryRun of [true, false]) {
        const res = await csvImport(rows, dryRun).expect(200);
        expect(res.body).toMatchObject({ dryRun, totalRows: 6, valid: 3, created: dryRun ? 0 : 3, failed: 3 });
        expect(res.body.errors.map((e: any) => [e.row, e.errors.join(' ')])).toEqual([
          [4, expect.stringMatching(/"Brand New School" was given by name only/)],
          [5, expect.stringMatching(/No school has code 229998/)],
          [6, expect.stringMatching(/does not match the school with code 220001 \("GS Ngoma Official"\)/)],
        ]);
        expect(await p().school.count()).toBe(schools);
      }
      const byCode = await p().user.findUniqueOrThrow({ where: { email: 'sa.csv.code@test.local' } });
      expect(byCode.schoolId).toBe(officialSouth);
      expect((await p().user.findUniqueOrThrow({ where: { email: 'sa.csv.id@test.local' } })).schoolId).toBe(officialKigali);
      expect(await p().user.count({ where: { email: { in: ['sa.csv.name@test.local', 'sa.csv.unknown@test.local', 'sa.csv.mismatch@test.local'] } } })).toBe(0);
      // Rejected rows leave no success audit entry.
      expect(await p().auditLog.count({ where: { action: 'CREATE_USER', metadata: { path: ['via'], equals: 'IMPORT' }, entityId: { in: [byCode.id] } } })).toBe(1);
    });

    it('Administrator create and edit accept schoolCode (same rules); schoolCode with schoolId: null is refused', async () => {
      const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
        firstName: 'C', lastName: 'Code', username: 'sa.create.code', email: 'sa.create.code@test.local', password: 'Str0ng!Passw0rd', role: 'STUDENT', gradeLevel: 'S2', schoolCode: '110001',
      }).expect(201);
      expect(await claimOf(created.body.id)).toMatchObject({ schoolId: officialKigali, status: 'PENDING' });
      await http().patch(`/api/v1/admin/users/${created.body.id}`).set(bearer(admin)).send({ schoolCode: '220001' }).expect(200);
      expect(await claimOf(created.body.id)).toMatchObject({ schoolId: officialSouth, status: 'PENDING' });
      expect(await status(http().patch(`/api/v1/admin/users/${created.body.id}`).set(bearer(admin)).send({ schoolCode: '220001', schoolId: null }))).toEqual([400, 'SCHOOL_REFERENCE_MISMATCH']);
      expect(await status(http().patch(`/api/v1/admin/users/${created.body.id}`).set(bearer(admin)).send({ schoolCode: '229997' }))).toEqual([400, 'UNKNOWN_SCHOOL_CODE']);
      expect(await status(http().patch(`/api/v1/admin/users/${created.body.id}`).set(bearer(admin)).send({ schoolCode: '22000' }))).toEqual([400, 'VALIDATION_FAILED']);
    });
  });

  // ─── Reading ───────────────────────────────────────────────────────────────

  it('list filters (text, code, country, place, active, source); detail counts; students with their claim status', async () => {
    const ids = async (query: object) => (await http().get(S).query({ limit: 100, ...query }).set(bearer(admin)).expect(200)).body.data.map((x: any) => x.id);
    expect(await ids({ q: 'GS Ngoma' })).toContain(officialSouth);
    expect(await ids({ q: '1100' })).toContain(officialKigali);
    expect(await ids({ source: 'LEGACY' })).toContain(legacy);
    expect(await ids({ source: 'OFFICIAL_LIST' })).not.toContain(legacy);
    expect(await ids({ countryCode: 'KE' })).toEqual(expect.arrayContaining([(await p().school.findFirstOrThrow({ where: { name: 'Nairobi School' } })).id]));
    expect(await ids({ district: 'Gasabo' })).toContain(officialKigali);
    expect(await ids({ isActive: 'true' })).not.toContain((await p().school.findFirst({ where: { isActive: false } }))?.id ?? 'none');
    const s = await mkStudent(officialKigali);
    const detail = (await http().get(`${S}/${officialKigali}`).set(bearer(admin)).expect(200)).body;
    expect(detail).toMatchObject({ id: officialKigali, source: 'OFFICIAL_LIST', counts: { students: expect.any(Number), pendingClaims: expect.any(Number) } });
    const students = (await http().get(`${S}/${officialKigali}/students`).query({ limit: 100 }).set(bearer(admin)).expect(200)).body.data;
    expect(students.find((x: any) => x.id === s)).toMatchObject({ claim: { status: 'PENDING' } });
    expect(JSON.stringify(students)).not.toMatch(/passwordHash|email/);
    await http().get(`${S}/00000000-0000-4000-8000-000000000000`).set(bearer(admin)).expect(404);
  });

  // ─── Atomicity ─────────────────────────────────────────────────────────────

  it('a failing audit write rolls back the school change: create, edit and deactivation leave nothing behind', async () => {
    const audit = ctx.app.get(AuditService);
    const failNext = () => vi.spyOn(audit, 'log').mockImplementationOnce(async () => { throw new Error('audit unavailable'); });
    let spy = failNext();
    try { expect((await create({ name: 'Rolled Back School', ...RW })).status).toBe(500); } finally { spy.mockRestore(); }
    expect(await p().school.count({ where: { name: 'Rolled Back School' } })).toBe(0);

    spy = failNext();
    try { expect((await http().patch(`${S}/${officialKigali}`).set(bearer(admin)).send({ location: 'Rolled back' })).status).toBe(500); } finally { spy.mockRestore(); }
    expect((await p().school.findUniqueOrThrow({ where: { id: officialKigali } })).location).not.toBe('Rolled back');

    spy = failNext();
    try { expect((await setActive(officialKigali, false)).status).toBe(500); } finally { spy.mockRestore(); }
    expect((await p().school.findUniqueOrThrow({ where: { id: officialKigali } })).isActive).toBe(true);
  });

  // ─── Concurrency (PostgreSQL in CI) ────────────────────────────────────────

  describe('concurrency', () => {
    const requireConcurrency = async (test: { skip: (note: string) => void }) => {
      if (await servesConcurrentConnections()) return true;
      if (process.env.CI) throw new Error('CI database must serve concurrent connections for this test.');
      test.skip('local single-connection database (prisma dev): runs in CI on PostgreSQL');
      return false;
    };
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('two creates racing for one name in one district, or one code: exactly one school, the others 409', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const byName = await Promise.all([1, 2, 3].map(() => create({ name: 'Race Name School', ...RW }).then((r) => [r.status, r.body.code ?? null])));
      expect(byName.filter(([s]) => s === 201)).toHaveLength(1);
      // M12: names are not unique; the name lock makes the later ones see the first as a possible duplicate.
      expect(byName.filter(([s]) => s !== 201)).toEqual([[409, 'POSSIBLE_DUPLICATE'], [409, 'POSSIBLE_DUPLICATE']]);
      expect(await p().school.count({ where: { name: 'Race Name School' } })).toBe(1);

      const byCode = await Promise.all(['A', 'B', 'C'].map((x) => create({ name: `Race Code ${x}`, code: '220321', ...RW }).then((r) => [r.status, r.body.code ?? null])));
      expect(byCode.filter(([s]) => s === 201)).toHaveLength(1);
      expect(byCode.filter(([s]) => s !== 201)).toEqual([[409, 'SCHOOL_CODE_TAKEN'], [409, 'SCHOOL_CODE_TAKEN']]);
      expect(await p().school.count({ where: { code: '220321' } })).toBe(1);
    });

    it('a deactivation waits for a use already in progress (it holds FOR SHARE until commit)', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const school = (await create({ name: 'Wait For Use School', ...RW }).expect(201)).body.id;
      const holder = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      const observer = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await holder.connect(); await observer.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM "School" WHERE "id" = $1 FOR SHARE`, [school]);   // as a claim in progress does
        const deactivate = setActive(school, false).then((r) => r.status);
        await wait(500);
        expect((await observer.query(`SELECT "isActive" FROM "School" WHERE "id" = $1`, [school])).rows[0].isActive).toBe(true);   // still waiting
        await holder.query('COMMIT');
        expect(await deactivate).toBe(200);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end(); await observer.end();
      }
      expect((await p().school.findUniqueOrThrow({ where: { id: school } })).isActive).toBe(false);
    });

    it('every new use started during a deactivation waits for it, then is refused (409 SCHOOL_INACTIVE): registration, invitation, verification, Teacher assignment', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const school = (await create({ name: 'Racing Closure School', code: '220654', ...RW }).expect(201)).body.id;
      const pending = await mkStudent(school);
      const pendingClaim = (await claimOf(pending)).id;
      const teacher3 = (await p().user.create({ data: { username: 'sa.teacher3', firstName: 'T3', lastName: 'T', email: 'sa.teacher3@test.local', role: 'TEACHER', activatedAt: new Date() } })).id;
      const holder = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await holder.connect();
      let results: unknown[];
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE "School" SET "isActive" = false WHERE "id" = $1`, [school]);   // a deactivation in progress
        const uses = [
          register('sa.race.reg', { schoolCode: '220654' }),
          invite('sa.race.inv@test.local', { schoolCode: '220654' }),
          http().post(`/api/v1/admin/school-affiliations/${pendingClaim}/verify`).set(bearer(admin)).send({}),
          http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId: teacher3, schoolId: school }),
        ].map((r) => r.then((x: any) => [x.status, x.body?.code ?? null]));
        await wait(500);
        await holder.query('COMMIT');
        results = await Promise.all(uses);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
      expect(results).toEqual([[409, 'SCHOOL_INACTIVE'], [409, 'SCHOOL_INACTIVE'], [409, 'SCHOOL_INACTIVE'], [409, 'SCHOOL_INACTIVE']]);
      expect(await p().user.count({ where: { username: 'sa.race.reg' } })).toBe(0);
      expect(await p().user.count({ where: { email: 'sa.race.inv@test.local' } })).toBe(0);
      expect(await claimOf(pending)).toMatchObject({ id: pendingClaim, status: 'PENDING' });
      expect(await p().teacherSchoolAssignment.count({ where: { teacherId: teacher3 } })).toBe(0);
    });
  });
});
