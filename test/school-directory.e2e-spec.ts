/**
 * School directory S1 — the data model and name rules (owner-approved 2026-11-11).
 *
 *   M12: names no longer unique (ordinary index), directory tables, new School columns; ids and
 *        relationships unchanged; rollback restores the unique index and removes only M12's
 *        objects — and refuses, changing nothing, while names repeat (no override) or while
 *        directory data exists (unless explicitly acknowledged); it never deletes a school.
 *   Database safeguards: source records keep their published data; external ids are permanent;
 *        contacts are REPRESENTATIVES only once verified; directory data blocks a school's deletion.
 *   Names: kept exactly as published; the same name elsewhere is another school; nearby it is a
 *        POSSIBLE_DUPLICATE (explicit, audited confirmation); the import maps rows back by id.
 *   Contacts (Administrators only), offerings, history, reference data; public search `level`.
 *   Atomic with the audit record; schools.manage only.
 *   Directory lock (PostgreSQL in CI): a sync (exclusive) and every school write (shared) block
 *        each other in both directions, with no deadlock.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

import { AuditService } from '../src/audit/audit.service.js';
import { IMPORT_COLUMNS } from '../src/schools/import/school-import.parser.js';
import { schoolKey } from '../src/schools/school-key.js';
import { lockSchoolDirectory } from '../src/schools/school-locks.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const ROOT = join(__dirname, '..');
/** A migration or rollback file without its BEGIN/COMMIT, to run inside a test's own transaction. */
const body = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n').split('\n')
  .filter((l) => !/^(BEGIN|COMMIT);$/.test(l.trim())).join('\n');
const M12 = body('prisma/migrations/20261121001100_school_directory_model/migration.sql');
const M12_ROLLBACK = body('docs/migrations/20261121001100_school_directory_model.rollback.sql');
const M12_TABLES = ['SchoolDataSource', 'SchoolExternalId', 'SchoolSourceRecord', 'SchoolContact', 'EducationLevel', 'SchoolEducationLevel', 'Programme', 'SchoolProgramme'];
const M12_COLUMNS = ['cell', 'village', 'accommodation', 'lastSourceSyncAt', 'lastVerifiedAt', 'lastVerifiedById'];
const M12_TYPES = ['SchoolAccommodation', 'SchoolContactType', 'SchoolContactVisibility', 'ProgrammeCategory', 'SchoolExternalIdKind'];

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

describe('School directory S1 (M12)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, teacher: string, headCoach: string, coach: string, student: string;
  let officialSouth: string, officialKigali: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const S = '/api/v1/admin/schools';
  const RW = { province: 'Southern Province', district: 'Huye', sector: 'Ngoma' };
  const KIGALI = { province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' };
  const MUSANZE = { province: 'Northern Province', district: 'Musanze', sector: 'Muhoza' };
  const errorCode = (r: { status: number; body?: any }) => (r.status >= 400 ? r.body?.code ?? null : null);
  const status = async (req: any) => { const r = await req; return [r.status, errorCode(r)]; };
  const create = (b: object, token = admin) => http().post(S).set(bearer(token)).send(b);
  const patch = (id: string, b: object) => status(http().patch(`${S}/${id}`).set(bearer(admin)).send(b));
  const putContacts = (id: string, contacts: object[], token = admin) => http().put(`${S}/${id}/contacts`).set(bearer(token)).send({ contacts });
  const putOfferings = (id: string, b: object, token = admin) => http().put(`${S}/${id}/offerings`).set(bearer(token)).send(b);
  const csv = (rows: string[][]) => [[...IMPORT_COLUMNS], ...rows].map((r) => r.join(',')).join('\r\n');
  const upload = (text: string, q: object = {}) => http().post(`${S}/import`).query(q).set(bearer(admin))
    .attach('file', Buffer.from(text, 'utf8'), { filename: 'schools.csv', contentType: 'text/csv' });
  const row = (name: string, place: Record<string, string> = RW, code = '') => [name, 'RW', code, place.province, place.district, place.sector, '', ''];
  const audits = (action: string, entityId?: string) => p().auditLog.count({ where: { action, ...(entityId && { entityId }) } });
  const pgClient = async () => { const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); return c; };

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    student = await login(ctx, 'student.j');
    const official = (name: string, code: string, place: typeof RW) => p().school.create({ data: {
      name, code, nameKey: schoolKey(name), location: `${place.sector}, ${place.district}`, ...place, ownership: 'PUBLIC', source: 'OFFICIAL_LIST',
    } });
    officialSouth = (await official('GS Ngoma Official', '220001', RW)).id;
    officialKigali = (await official('GS Kacyiru Official', '110001', KIGALI)).id;
    await official('GS Muhoza Official', '410001', MUSANZE);
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    for (const [username, role] of [['sd.teacher', 'TEACHER'], ['sd.head', 'HEAD_COACH'], ['sd.super', 'SUPER_ADMIN']] as const) {
      await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
    }
    [teacher, headCoach, superAdmin] = await Promise.all(['sd.teacher', 'sd.head', 'sd.super'].map((u) => login(ctx, u)));
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  // ─── M12 ─────────────────────────────────────────────────────────────────────

  describe('M12 (the real SQL)', () => {
    const links = (q: (sql: string) => Promise<any[]>) => q(`
      SELECT (SELECT json_agg(json_build_object('id', "id", 'name', "name", 'code', "code") ORDER BY "id") FROM "School") AS schools,
             (SELECT json_agg(json_build_object('u', "id", 's', "schoolId") ORDER BY "id") FROM "User") AS users,
             (SELECT json_agg(json_build_object('e', "id", 's', "schoolId") ORDER BY "id") FROM "StudentEnrollment") AS enrolments,
             (SELECT json_agg(json_build_object('a', "id", 's', "schoolId") ORDER BY "id") FROM "StudentSchoolAffiliation") AS claims,
             (SELECT json_agg(json_build_object('t', "id", 's', "schoolId") ORDER BY "id") FROM "TeacherSchoolAssignment") AS teachers`);

    it('rollback restores the unique name index and removes only M12\'s objects; re-applying recreates them and the reference rows; ids and every relationship unchanged', async () => {
      const c = await pgClient();
      const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
      const tables = async () => (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, [M12_TABLES]))[0].n;
      const columns = async () => (await q(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'School' AND column_name = ANY($1)`, [M12_COLUMNS]))[0].n;
      const types = async () => (await q(`SELECT count(*)::int AS n FROM pg_type WHERE typname = ANY($1)`, [M12_TYPES]))[0].n;
      const functions = async () => (await q(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('school_source_record_immutable', 'school_external_id_keep')`))[0].n;
      const nameIndexes = async () => (await q(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'School' AND indexname IN ('School_name_key', 'School_name_idx') ORDER BY indexname`))
        .map((r) => [r.indexname, /UNIQUE/.test(r.indexdef)]);
      try {
        const before = await links(q);
        expect(await nameIndexes()).toEqual([['School_name_idx', false]]);
        await c.query('BEGIN');
        await c.query(M12_ROLLBACK);
        expect([await tables(), await columns(), await types(), await functions()]).toEqual([0, 0, 0, 0]);
        expect(await nameIndexes()).toEqual([['School_name_key', true]]);
        expect((await q(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '20261121001100_school_directory_model'`))[0].n).toBe(1);   // history untouched
        expect(await links(q)).toEqual(before);

        await c.query(M12);
        expect([await tables(), await columns(), await types(), await functions()]).toEqual([8, 6, 5, 2]);
        expect(await nameIndexes()).toEqual([['School_name_idx', false]]);
        expect((await q(`SELECT array_agg("code" ORDER BY "sortOrder") AS codes FROM "EducationLevel"`))[0].codes).toEqual(['PPR', 'PR', 'OL', 'AL', 'PE']);
        expect((await q(`SELECT array_agg("key") AS keys FROM "SchoolDataSource"`))[0].keys).toEqual(['NESA']);
        expect(await links(q)).toEqual(before);
        await c.query('ROLLBACK');
        expect(await tables()).toBe(8);   // nothing persisted
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    });

    it('rollback refuses — changing nothing — while names repeat (even when acknowledged) and while directory data exists unless explicitly acknowledged; it never deletes a school', async () => {
      const c = await pgClient();
      const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
      const schools = async () => (await q(`SELECT count(*)::int AS n FROM "School"`))[0].n;
      const attempt = async (setup: string[], acknowledge: boolean) => {
        await c.query('BEGIN');
        try {
          for (const sql of setup) await c.query(sql);
          const count = await schools();
          if (acknowledge) await c.query(`SET LOCAL rof.m12_rollback = 'discard-directory-data'`);
          await c.query(M12_ROLLBACK);
          const tables = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, [M12_TABLES]))[0].n;
          return { applied: true, tables, schoolsKept: (await schools()) === count };
        } catch (err) {
          return { applied: false, message: (err as Error).message };
        } finally {
          await c.query('ROLLBACK');
        }
      };
      const repeatName = `INSERT INTO "School" ("id", "name", "location") VALUES (gen_random_uuid()::text, 'GS Ngoma Official', 'Somewhere else')`;
      const contact = `INSERT INTO "SchoolContact" ("id", "schoolId", "type", "value") VALUES (gen_random_uuid()::text, '${officialSouth}', 'EMAIL', 'gs@ngoma.rw')`;
      const cell = `UPDATE "School" SET "cell" = 'Rugali' WHERE "id" = '${officialSouth}'`;
      try {
        const before = await schools();
        for (const ack of [false, true]) {
          expect(await attempt([repeatName], ack)).toEqual({ applied: false, message: expect.stringMatching(/M12_ROLLBACK_REFUSED: 1 school names are shared .*"GS Ngoma Official".*never by deleting schools/) });
        }
        for (const setup of [[contact], [cell]]) {
          expect(await attempt(setup, false)).toEqual({ applied: false, message: expect.stringMatching(/M12_ROLLBACK_REFUSED: 1 directory rows \/ values would be lost/) });
          expect(await attempt(setup, true)).toEqual({ applied: true, tables: 0, schoolsKept: true });
        }
        expect(await attempt([], false)).toEqual({ applied: true, tables: 0, schoolsKept: true });   // nothing to lose: no acknowledgement needed
        expect(await schools()).toBe(before);
        expect((await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY($1)`, [M12_TABLES]))[0].n).toBe(8);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    });

    it('database safeguards: source records keep their published data; external ids are permanent (one key, one school); REPRESENTATIVES only once verified; directory data blocks deleting a school', async () => {
      const nesa = await p().schoolDataSource.findUniqueOrThrow({ where: { key: 'NESA' } });
      const raw = { 'School Code': '220001', 'School Name': 'GS NGOMA OFFICIAL', Email: 'N/A', Phone: 'No Primary' };
      const rec = await p().schoolSourceRecord.create({ data: {
        dataSourceId: nesa.id, datasetLabel: 'NESA accredited schools (test)', datasetSha256: 'a'.repeat(64), sourceRef: 'All Schools!7',
        raw, rowHash: 'b'.repeat(64), issues: ['Email: N/A', 'Phone: No Primary'], issueCount: 2,
      } });
      await p().schoolSourceRecord.update({ where: { id: rec.id }, data: { schoolId: officialSouth, matchedBy: 'CODE' } });   // linking is allowed
      await expect(p().schoolSourceRecord.update({ where: { id: rec.id }, data: { raw: { changed: true } } })).rejects.toThrow(/SCHOOL_SOURCE_RECORD_IMMUTABLE/);
      await expect(p().schoolSourceRecord.update({ where: { id: rec.id }, data: { sourceRef: 'All Schools!8' } })).rejects.toThrow(/SCHOOL_SOURCE_RECORD_IMMUTABLE/);
      await expect(p().schoolSourceRecord.delete({ where: { id: rec.id } })).rejects.toThrow(/SCHOOL_SOURCE_RECORD_IMMUTABLE/);
      expect(await p().schoolSourceRecord.findUniqueOrThrow({ where: { id: rec.id } })).toMatchObject({ raw, schoolId: officialSouth, matchedBy: 'CODE' });

      const code = await p().schoolExternalId.create({ data: { dataSourceId: nesa.id, externalKey: '220001', kind: 'CODE', schoolId: officialSouth } });
      // An earlier fingerprint stays with the school (a matching aid, not an identity that is replaced).
      await p().schoolExternalId.create({ data: { dataSourceId: nesa.id, externalKey: 'fp:gs ngoma official|huye|ngoma', kind: 'FINGERPRINT', schoolId: officialSouth, supersededAt: new Date() } });
      await expect(p().schoolExternalId.delete({ where: { id: code.id } })).rejects.toThrow(/SCHOOL_EXTERNAL_ID_PERMANENT/);
      await expect(p().schoolExternalId.create({ data: { dataSourceId: nesa.id, externalKey: '220001', kind: 'CODE', schoolId: officialKigali } })).rejects.toThrow();
      expect(await p().schoolExternalId.count({ where: { schoolId: officialSouth } })).toBe(2);

      await expect(p().schoolContact.create({ data: { schoolId: officialKigali, type: 'EMAIL', value: 'unverified@kacyiru.rw', visibility: 'REPRESENTATIVES' } })).rejects.toThrow();
      expect(await p().schoolContact.count({ where: { schoolId: officialKigali } })).toBe(0);

      const doomed = await p().school.create({ data: { name: 'Delete Me Not', location: 'Huye' } });
      await p().schoolContact.create({ data: { schoolId: doomed.id, type: 'PHONE', value: '+250788000001' } });
      await expect(p().school.delete({ where: { id: doomed.id } })).rejects.toThrow();
      expect(await p().schoolContact.count({ where: { schoolId: doomed.id } })).toBe(1);
    });
  });

  // ─── Names repeat ────────────────────────────────────────────────────────────

  describe('names are kept as published and may repeat', () => {
    it('the same official name in several districts coexists; an Administrator adds another elsewhere without confirmation; told apart by code and place', async () => {
      for (const [code, place] of [['220010', RW], ['110010', KIGALI]] as const) {
        await p().school.create({ data: { name: 'EP KARAMA', code, nameKey: 'ep karama', location: `${place.sector}, ${place.district}`, ...place, source: 'OFFICIAL_LIST' } });
      }
      const third = await create({ name: 'EP KARAMA', ...MUSANZE }).expect(201);
      expect(third.body).toMatchObject({ name: 'EP KARAMA', district: 'Musanze', code: null });
      expect(await p().school.count({ where: { name: 'EP KARAMA' } })).toBe(3);
      const found = (await http().get('/api/v1/schools/search').query({ q: 'EP KARAMA' }).expect(200)).body;
      expect(found.map((s: any) => [s.code, s.district]).sort()).toEqual([['110010', 'Gasabo'], ['220010', 'Huye']]);   // the public directory: coded schools
      expect((await http().get(S).query({ q: 'EP KARAMA' }).set(bearer(admin)).expect(200)).body.data).toHaveLength(3);
    });

    it('the same name in the same district: POSSIBLE_DUPLICATE with each candidate\'s code and place; a confirmed create is audited', async () => {
      const dup = await create({ name: 'EP KARAMA', ...RW }).expect(409);
      expect(dup.body).toMatchObject({ code: 'POSSIBLE_DUPLICATE', details: { candidates: [expect.objectContaining({ name: 'EP KARAMA', code: '220010', district: 'Huye' })] } });
      const confirmed = await create({ name: 'EP KARAMA', ...RW, confirmPossibleDuplicate: true }).expect(201);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'CREATE_SCHOOL', entityId: confirmed.body.id } })).metadata)
        .toMatchObject({ confirmedPossibleDuplicate: true, school: { name: 'EP KARAMA', district: 'Huye' } });
    });

    it('PATCH: renaming to a name used in another district is accepted; in the same district it needs confirmation', async () => {
      const school = (await create({ name: 'Renamable School', ...KIGALI }).expect(201)).body.id;
      expect(await patch(school, { name: 'GS Muhoza Official' })).toEqual([200, null]);   // GS Muhoza Official is in Musanze
      expect(await patch(school, { name: 'GS Kacyiru Official' })).toEqual([409, 'POSSIBLE_DUPLICATE']);
      expect(await patch(school, { name: 'GS Kacyiru Official', confirmPossibleDuplicate: true })).toEqual([200, null]);
      expect(await p().school.count({ where: { name: 'GS Kacyiru Official' } })).toBe(2);
    });

    it('import: the same name in two districts of one file → both created, each school mapped back to its own row by id', async () => {
      const res = await upload(csv([row('Twin Name School', RW), row('Twin Name School', KIGALI)])).expect(201);
      expect(res.body.schools.map((s: any) => [s.row, s.name])).toEqual([[2, 'Twin Name School'], [3, 'Twin Name School']]);
      const [a, b] = await Promise.all(res.body.schools.map((s: any) => p().school.findUniqueOrThrow({ where: { id: s.id } })));
      expect([a.district, b.district]).toEqual(['Huye', 'Gasabo']);
      for (const s of res.body.schools) {
        expect((await p().auditLog.findFirstOrThrow({ where: { action: 'CREATE_SCHOOL', entityId: s.id } })).metadata).toMatchObject({ via: 'IMPORT', row: s.row });
      }
    });
  });

  // ─── New fields ──────────────────────────────────────────────────────────────

  it('cell, village, accommodation: trimmed (inner whitespace collapsed), returned and audited; Rwanda only; an official school\'s cell / village change needs a reason; null clears', async () => {
    const res = await create({ name: 'Fields School', ...RW, cell: '  Rugali ', village: ' Nyamugari   Hejuru ', accommodation: 'BOARDING' }).expect(201);
    expect(res.body).toMatchObject({ cell: 'Rugali', village: 'Nyamugari Hejuru', accommodation: 'BOARDING' });
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'CREATE_SCHOOL', entityId: res.body.id } })).metadata)
      .toMatchObject({ school: { cell: 'Rugali', village: 'Nyamugari Hejuru', accommodation: 'BOARDING' } });
    expect(await status(create({ name: 'Kenya Cell School', countryCode: 'KE', location: 'Nairobi', cell: 'Westlands' }))).toEqual([400, 'SCHOOL_DIRECTORY_RWANDA_ONLY']);
    expect(await status(create({ name: 'Hostel School', ...RW, accommodation: 'HOSTEL' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(create({ name: 'Bell School', ...RW, cell: 'Ru\u0007gali' }))).toEqual([400, 'VALIDATION_FAILED']);

    expect(await patch(officialKigali, { cell: 'Kamutwa' })).toEqual([400, 'REASON_REQUIRED']);
    expect(await patch(officialKigali, { cell: 'Kamutwa', village: 'Urugwiro', reason: 'As in the NESA directory' })).toEqual([200, null]);
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'UPDATE_SCHOOL', entityId: officialKigali }, orderBy: { createdAt: 'desc' } })).metadata)
      .toMatchObject({ changes: { cell: { from: null, to: 'Kamutwa' }, village: { from: null, to: 'Urugwiro' } }, reason: 'As in the NESA directory' });
    expect(await patch(officialKigali, { accommodation: 'DAY' })).toEqual([200, null]);   // not a directory field: no reason
    expect(await patch(officialKigali, { accommodation: null })).toEqual([200, null]);
    expect(await p().school.findUniqueOrThrow({ where: { id: officialKigali } })).toMatchObject({ cell: 'Kamutwa', village: 'Urugwiro', accommodation: null });
  });

  // ─── Contacts ────────────────────────────────────────────────────────────────

  describe('contacts', () => {
    let school: string, other: string;
    const contactsOf = async (id: string) => (await http().get(`${S}/${id}/contacts`).set(bearer(admin)).expect(200)).body.contacts;
    const asInput = (c: any) => ({ id: c.id, type: c.type, value: c.value, ...(c.label && { label: c.label }), isPrimary: c.isPrimary });

    beforeAll(async () => {
      school = (await create({ name: 'Contact School', code: '220901', ...RW }).expect(201)).body.id;
      other = (await create({ name: 'Other Contact School', ...KIGALI }).expect(201)).body.id;
    });

    it('replace: normalised, the value as entered kept, ADMIN_ONLY and unverified by default; audited; the same list again changes nothing', async () => {
      expect(await contactsOf(school)).toEqual([]);
      const res = await putContacts(school, [
        { type: 'EMAIL', value: ' Head@GS-Contact.RW ', isPrimary: true },
        { type: 'PHONE', value: '0788 123 456', label: 'Head teacher' },
        { type: 'PHONE', value: '+250 722 000 111' },
      ]).expect(200);
      expect(res.body.changed).toBe(true);
      expect(res.body.contacts.map((c: any) => [c.type, c.value, c.rawValue, c.label, c.isPrimary, c.visibility, c.verifiedAt])).toEqual([
        ['EMAIL', 'head@gs-contact.rw', 'Head@GS-Contact.RW', null, true, 'ADMIN_ONLY', null],
        ['PHONE', '+250722000111', '+250 722 000 111', null, false, 'ADMIN_ONLY', null],
        ['PHONE', '+250788123456', '0788 123 456', 'Head teacher', false, 'ADMIN_ONLY', null],
      ]);
      const log = await p().auditLog.findFirstOrThrow({ where: { action: 'UPDATE_SCHOOL_CONTACTS', entityId: school } });
      expect(log).toMatchObject({ actorId: ctx.ids.admin, entity: 'School' });
      expect((log.metadata as any).added).toHaveLength(3);
      const logs = await audits('UPDATE_SCHOOL_CONTACTS', school);
      const again = await putContacts(school, res.body.contacts.map(asInput)).expect(200);
      expect(again.body.changed).toBe(false);
      expect(await audits('UPDATE_SCHOOL_CONTACTS', school)).toBe(logs);
    });

    it('refused with 400 INVALID_CONTACTS (nothing changed): an unreadable phone or e-mail, a repeated value, two primary e-mails, another school\'s contact', async () => {
      const before = await contactsOf(school);
      const foreign = (await putContacts(other, [{ type: 'EMAIL', value: 'office@other.rw' }]).expect(200)).body.contacts[0];
      for (const contacts of [
        [{ type: 'PHONE', value: 'No Primary' }],
        [{ type: 'PHONE', value: '07881234O6' }],
        [{ type: 'EMAIL', value: 'N/A' }],
        [{ type: 'PHONE', value: '0788123456' }, { type: 'PHONE', value: '+250 788 123 456' }],
        [{ type: 'EMAIL', value: 'a@x.rw', isPrimary: true }, { type: 'EMAIL', value: 'b@x.rw', isPrimary: true }],
        [{ id: foreign.id, type: 'EMAIL', value: 'office@other.rw' }],
      ]) {
        const r = await putContacts(school, contacts);
        expect([contacts, r.status, errorCode(r)]).toEqual([contacts, 400, 'INVALID_CONTACTS']);
      }
      expect(await status(putContacts(school, [{ type: 'FAX', value: '123' }]))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await contactsOf(school)).toEqual(before);
    });

    it('verify: REPRESENTATIVES only through an Administrator\'s verification (audited); a changed value loses it; values can be exchanged; removal is audited', async () => {
      const [email, phoneA, phoneB] = await contactsOf(school);
      const verified = await http().post(`${S}/${school}/contacts/${phoneB.id}/verify`).set(bearer(admin)).send({ visibility: 'REPRESENTATIVES', reason: 'Called the head teacher' }).expect(200);
      expect(verified.body).toMatchObject({ visibility: 'REPRESENTATIVES', verifiedAt: expect.any(String), verifiedBy: { id: ctx.ids.admin } });
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_CONTACT_VERIFIED', entityId: school } })).metadata)
        .toMatchObject({ contact: { id: phoneB.id, value: '+250788123456' }, visibility: 'REPRESENTATIVES', previous: { verifiedAt: null, visibility: 'ADMIN_ONLY' } });
      await http().post(`${S}/${school}/contacts/${email.id}/verify`).set(bearer(admin)).send({}).expect(200);   // verified, still ADMIN_ONLY
      expect(await status(http().post(`${S}/${other}/contacts/${email.id}/verify`).set(bearer(admin)).send({}))).toEqual([404, expect.any(String)]);

      // Exchange the two phone numbers: each contact's value changes → both lose their verification.
      const swapped = await putContacts(school, [asInput(email), { ...asInput(phoneA), value: phoneB.value }, { ...asInput(phoneB), value: phoneA.value }]).expect(200);
      const byId = new Map(swapped.body.contacts.map((c: any) => [c.id, c]));
      expect(byId.get(phoneA.id)).toMatchObject({ value: '+250788123456', visibility: 'ADMIN_ONLY', verifiedAt: null });
      expect(byId.get(phoneB.id)).toMatchObject({ value: '+250722000111', visibility: 'ADMIN_ONLY', verifiedAt: null });
      expect(byId.get(email.id)).toMatchObject({ verifiedAt: expect.any(String) });   // unchanged: keeps its verification
      const swapLog = await p().auditLog.findFirstOrThrow({ where: { action: 'UPDATE_SCHOOL_CONTACTS', entityId: school }, orderBy: { createdAt: 'desc' } });
      expect((swapLog.metadata as any).changed).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: phoneB.id, verificationReset: true, previousVisibility: 'REPRESENTATIVES' }),
      ]));

      const removed = await putContacts(school, [asInput(email)]).expect(200);
      expect(removed.body.contacts).toHaveLength(1);
      const removeLog = await p().auditLog.findFirstOrThrow({ where: { action: 'UPDATE_SCHOOL_CONTACTS', entityId: school }, orderBy: { createdAt: 'desc' } });
      expect((removeLog.metadata as any).removed.map((c: any) => c.id).sort()).toEqual([phoneA.id, phoneB.id].sort());
      await putContacts(school, [asInput(email), { type: 'PHONE', value: '0788123456' }]).expect(200);
    });

    it('never outside Administrator routes: public search and locations, registration, the deprecated /schools routes, the admin list and record carry no contact', async () => {
      const secrets = ['head@gs-contact.rw', '788123456'];
      const responses = [
        await http().get('/api/v1/schools/search').query({ q: 'Contact School' }).expect(200),
        await http().get('/api/v1/schools/search').query({ district: 'Huye', sector: 'Ngoma' }).expect(200),
        await http().get('/api/v1/schools/locations').expect(200),
        await http().post('/api/v1/auth/register/student').send({
          firstName: 'Reg', lastName: 'Contact', username: 'sd.reg.contact', email: 'sd.reg.contact@test.local', password: 'Secret123',
          gradeLevel: 'S2', homeLocation: 'Huye', schoolCode: '220901',
        }),
        await http().get('/api/v1/schools').query({ search: 'Contact School' }).set(bearer(admin)).expect(200),
        await http().get(`/api/v1/schools/${school}`).set(bearer(superAdmin)).expect(200),
        await http().get(S).query({ q: 'Contact School' }).set(bearer(superAdmin)).expect(200),
        await http().get(`${S}/${school}`).set(bearer(admin)).expect(200),
      ];
      expect(responses[0].body.map((s: any) => s.code)).toEqual(['220901']);
      expect(responses[3].status).toBeLessThan(300);
      responses.forEach((r, i) => { for (const secret of secrets) expect([i, JSON.stringify(r.body).includes(secret)]).toEqual([i, false]); });
    });
  });

  // ─── Offerings, reference data, filters ─────────────────────────────────────

  describe('offerings', () => {
    let school: string, reviewed: string, unreviewed: string;
    beforeAll(async () => {
      school = (await create({ name: 'Offering School', code: '220902', ...RW, accommodation: 'MIXED' }).expect(201)).body.id;
      reviewed = (await p().programme.create({ data: { code: 'MCB', name: 'Mathematics-Chemistry-Biology', category: 'A_LEVEL_COMBINATION', needsReview: false } })).id;
      unreviewed = (await p().programme.create({ data: { name: 'Software Development', category: 'TVET_TRADE', tvetLevel: 5 } })).id;
    });

    it('reference data: the education levels and the programmes, with their review state', async () => {
      const ref = (await http().get(`${S}/reference-data`).set(bearer(admin)).expect(200)).body;
      expect(ref.educationLevels.map((l: any) => l.code)).toEqual(['PPR', 'PR', 'OL', 'AL', 'PE']);
      expect(ref.programmes.map((x: any) => [x.name, x.needsReview])).toEqual([['Mathematics-Chemistry-Biology', false], ['Software Development', true]]);
    });

    it('replace levels and programmes: audited; the same again changes nothing; unknown or repeated entries refused (nothing changed)', async () => {
      const res = await putOfferings(school, { levels: [{ code: 'pr' }, { code: 'OL', qualifier: 'L' }], programmes: [{ id: reviewed }, { id: unreviewed }] }).expect(200);
      expect(res.body).toMatchObject({ changed: true, levels: [{ code: 'PR', name: 'Primary', qualifier: null }, { code: 'OL', name: 'Ordinary Level', qualifier: 'L' }] });
      expect(res.body.programmes.map((x: any) => [x.id, x.needsReview])).toEqual([[reviewed, false], [unreviewed, true]]);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'UPDATE_SCHOOL_OFFERINGS', entityId: school } })).metadata).toMatchObject({
        levels: { added: [{ code: 'PR', qualifier: null }, { code: 'OL', qualifier: 'L' }], removed: [], changed: [] }, programmes: { added: [reviewed, unreviewed], removed: [] },
      });
      const logs = await audits('UPDATE_SCHOOL_OFFERINGS', school);
      expect((await putOfferings(school, { levels: [{ code: 'PR' }, { code: 'OL', qualifier: 'L' }], programmes: [{ id: unreviewed }, { id: reviewed }] }).expect(200)).body.changed).toBe(false);
      expect(await audits('UPDATE_SCHOOL_OFFERINGS', school)).toBe(logs);
      for (const b of [
        { levels: [{ code: 'XX' }], programmes: [] },
        { levels: [{ code: 'PR' }, { code: 'pr' }], programmes: [] },
        { levels: [], programmes: [{ id: '00000000-0000-4000-8000-000000000000' }] },
      ]) expect([b, ...(await status(putOfferings(school, b)))]).toEqual([b, 400, 'INVALID_OFFERINGS']);
      const changed = await putOfferings(school, { levels: [{ code: 'OL' }], programmes: [{ id: reviewed }] }).expect(200);
      expect(changed.body.levels).toEqual([expect.objectContaining({ code: 'OL', qualifier: null })]);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'UPDATE_SCHOOL_OFFERINGS', entityId: school }, orderBy: { createdAt: 'desc' } })).metadata).toMatchObject({
        levels: { added: [], removed: [{ code: 'PR' }], changed: [{ code: 'OL', from: 'L', to: null }] }, programmes: { added: [], removed: [unreviewed] },
      });
      await putOfferings(school, { levels: [{ code: 'PR' }, { code: 'OL' }], programmes: [{ id: reviewed }, { id: unreviewed }] }).expect(200);
    });

    it('public search by level: only schools offering it; the response is unchanged (no programmes, no contacts)', async () => {
      const found = (await http().get('/api/v1/schools/search').query({ district: 'Huye', sector: 'Ngoma', level: 'ol' }).expect(200)).body;
      expect(found.map((s: any) => s.code)).toEqual(['220902']);
      expect(Object.keys(found[0]).sort()).toEqual(['code', 'district', 'id', 'location', 'name', 'sector']);
      expect((await http().get('/api/v1/schools/search').query({ district: 'Huye', sector: 'Ngoma', level: 'AL' }).expect(200)).body).toEqual([]);
    });

    it('admin list filters: level, programme, accommodation, without a code, with source problems', async () => {
      const ids = async (q: object) => ((await http().get(S).query({ limit: 100, ...q }).set(bearer(admin)).expect(200)).body.data as any[]).map((s) => s.id);
      expect(await ids({ level: 'OL' })).toEqual([school]);
      expect(await ids({ programme: unreviewed })).toEqual([school]);
      expect(await ids({ accommodation: 'MIXED' })).toEqual([school]);
      const uncoded = await ids({ hasCode: false });
      expect(uncoded).not.toContain(school);
      expect(uncoded).toContain((await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id);
      expect(await ids({ hasSourceIssues: true })).toEqual([officialSouth]);   // its source record lists problems
      expect(await ids({ hasSourceIssues: false })).not.toContain(officialSouth);
      expect(await status(http().get(S).query({ accommodation: 'HOSTEL' }).set(bearer(admin)))).toEqual([400, 'VALIDATION_FAILED']);
    });
  });

  // ─── History ─────────────────────────────────────────────────────────────────

  it('history: the school\'s audit entries (newest first) and the source records matched with it', async () => {
    const h = (await http().get(`${S}/${officialSouth}/history`).set(bearer(admin)).expect(200)).body;
    expect(h.sourceRecords).toEqual([expect.objectContaining({
      dataSource: { key: 'NESA', name: expect.any(String) }, sourceRef: 'All Schools!7', matchedBy: 'CODE',
      raw: expect.objectContaining({ 'School Code': '220001', Email: 'N/A' }), issues: ['Email: N/A', 'Phone: No Primary'],
    })]);
    const apart = () => new Promise((r) => setTimeout(r, 10));   // distinct timestamps: the order is by time
    const school = (await create({ name: 'History School', ...RW }).expect(201)).body.id;
    await apart();
    await putContacts(school, [{ type: 'EMAIL', value: 'history@x.rw' }]).expect(200);
    await apart();
    await putOfferings(school, { levels: [{ code: 'PR' }], programmes: [] }).expect(200);
    const log = (await http().get(`${S}/${school}/history`).set(bearer(admin)).expect(200)).body;
    expect(log.audit.data.map((a: any) => a.action)).toEqual(['UPDATE_SCHOOL_OFFERINGS', 'UPDATE_SCHOOL_CONTACTS', 'CREATE_SCHOOL']);
    expect(log.sourceRecords).toEqual([]);
    expect(await status(http().get(`${S}/00000000-0000-4000-8000-000000000000/history`).set(bearer(admin)))).toEqual([404, expect.any(String)]);
  });

  // ─── Authorization ───────────────────────────────────────────────────────────

  it('schools.manage only: every new route 403 for Teachers, Head Coaches, Coaches and Students, 401 anonymous; Administrators and Super Admins allowed', async () => {
    const id = officialKigali;
    const fake = '00000000-0000-4000-8000-000000000000';
    const routes: Array<[string, string, object?]> = [
      ['get', `${S}/reference-data`], ['get', `${S}/${id}/contacts`], ['put', `${S}/${id}/contacts`, { contacts: [] }],
      ['post', `${S}/${id}/contacts/${fake}/verify`, {}], ['get', `${S}/${id}/offerings`], ['put', `${S}/${id}/offerings`, { levels: [], programmes: [] }],
      ['get', `${S}/${id}/history`],
    ];
    for (const token of [teacher, headCoach, coach, student]) {
      for (const [m, url, b] of routes) expect([m, url, (await (http() as any)[m](url).set(bearer(token)).send(b ?? {})).status]).toEqual([m, url, 403]);
    }
    for (const [m, url, b] of routes) expect([m, url, (await (http() as any)[m](url).send(b ?? {})).status]).toEqual([m, url, 401]);
    for (const token of [admin, superAdmin]) {
      for (const [m, url, b] of routes) {
        const r = await (http() as any)[m](url).set(bearer(token)).send(b ?? {});
        expect([m, url, r.status]).toEqual([m, url, url.endsWith('/verify') ? 404 : 200]);   // the contact does not exist
      }
    }
    expect(await p().schoolContact.count({ where: { schoolId: id } })).toBe(0);
  });

  // ─── Atomicity ───────────────────────────────────────────────────────────────

  it('atomic with the audit record: when the audit write fails, contacts, verification and offerings are unchanged', async () => {
    const audit = ctx.app.get(AuditService);
    const failNext = () => vi.spyOn(audit, 'log').mockImplementationOnce(async () => { throw new Error('audit unavailable'); });
    const school = (await create({ name: 'Atomic Directory School', ...RW }).expect(201)).body.id;
    const [contact] = (await putContacts(school, [{ type: 'EMAIL', value: 'atomic@x.rw' }]).expect(200)).body.contacts;
    await putOfferings(school, { levels: [{ code: 'PR' }], programmes: [] }).expect(200);
    const snapshot = async () => [
      await p().schoolContact.findMany({ where: { schoolId: school }, orderBy: { id: 'asc' } }),
      await p().schoolEducationLevel.findMany({ where: { schoolId: school }, orderBy: { levelCode: 'asc' } }),
    ];
    const before = await snapshot();
    failNext();
    expect((await putContacts(school, [{ type: 'EMAIL', value: 'changed@x.rw' }, { type: 'PHONE', value: '0788000002' }])).status).toBe(500);
    failNext();
    expect((await http().post(`${S}/${school}/contacts/${contact.id}/verify`).set(bearer(admin)).send({ visibility: 'REPRESENTATIVES' })).status).toBe(500);
    failNext();
    expect((await putOfferings(school, { levels: [{ code: 'OL' }, { code: 'AL' }], programmes: [] })).status).toBe(500);
    expect(await snapshot()).toEqual(before);
    vi.restoreAllMocks();
  });

  // ─── Directory lock (PostgreSQL in CI) ───────────────────────────────────────

  describe('directory lock (D1)', () => {
    const requireConcurrency = async (test: { skip: (note: string) => void }) => {
      if (await servesConcurrentConnections()) return true;
      if (process.env.CI) throw new Error('CI database must serve concurrent connections for this test.');
      test.skip('local single-connection database (prisma dev): runs in CI on PostgreSQL');
      return false;
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let watcher: pg.Client;
    /** The directory lock in pg_locks: mode ShareLock (school writes) or ExclusiveLock (a sync), granted or waiting. */
    const directoryLocks = async (mode: 'ShareLock' | 'ExclusiveLock', granted: boolean) => (await watcher.query(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND classid = 4215 AND objid = 0 AND objsubid = 2 AND mode = $1 AND granted = $2`,
      [mode, granted])).rows[0].n as number;
    const until = async (label: string, check: () => Promise<boolean>) => {
      for (let i = 0; i < 100; i++) { if (await check()) return; await sleep(50); }
      throw new Error(`timed out waiting for: ${label}`);
    };
    /** A sync's hold on the directory: the application's own lockSchoolDirectory(tx, 'exclusive'), kept until release(). */
    const holdSync = () => {
      let release!: () => void;
      let acquired!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const acquiredP = new Promise<void>((r) => { acquired = r; });
      const done = p().$transaction(async (tx) => { await lockSchoolDirectory(tx, 'exclusive'); acquired(); await gate; }, { timeout: 30_000, maxWait: 10_000 });
      return { acquired: acquiredP, release: async () => { release(); await done; } };
    };
    const tracked = <T>(promise: Promise<T>) => { const t = { settled: false, promise }; promise.then(() => { t.settled = true; }, () => { t.settled = true; }); return t; };
    /** Starts a supertest request now (a Test starts when its then() is called). */
    const start = (req: () => PromiseLike<any>) => tracked(Promise.resolve().then(req));

    beforeAll(async () => { watcher = await pgClient(); });
    afterAll(async () => { await watcher?.end(); });

    it('a sync (exclusive) blocks create, PATCH, setActive, the general import, contacts, verification and offerings until it ends; then each completes', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const target = (await create({ name: 'Lock Target School', ...RW }).expect(201)).body.id;
      const [contact] = (await putContacts(target, [{ type: 'EMAIL', value: 'lock@x.rw' }]).expect(200)).body.contacts;
      const ops: Array<[string, () => PromiseLike<any>, number]> = [
        ['create', () => create({ name: 'Lock Created School', ...RW }), 201],
        ['PATCH', () => http().patch(`${S}/${target}`).set(bearer(admin)).send({ location: 'Ngoma, near the market' }), 200],
        ['setActive', () => http().patch(`${S}/${target}/active`).set(bearer(admin)).send({ isActive: false, reason: 'Lock test' }), 200],
        ['import', () => upload(csv([row('Lock Imported School')])), 201],
        ['contacts', () => putContacts(target, [{ id: contact.id, type: 'EMAIL', value: 'lock@x.rw' }, { type: 'PHONE', value: '0788000003' }]), 200],
        ['verify', () => http().post(`${S}/${target}/contacts/${contact.id}/verify`).set(bearer(admin)).send({}), 200],
        ['offerings', () => putOfferings(target, { levels: [{ code: 'PR' }], programmes: [] }), 200],
      ];
      for (const [label, op, expected] of ops) {
        const sync = holdSync();
        await sync.acquired;
        const req = start(op);
        await until(`${label} waits for the directory`, async () => (await directoryLocks('ShareLock', false)) === 1);
        await sleep(200);
        expect([label, req.settled]).toEqual([label, false]);
        await sync.release();
        expect([label, (await req.promise).status]).toEqual([label, expected]);
      }
    });

    it('a school write in progress (shared) blocks a sync until it commits — create, PATCH, setActive, the general import, contacts, offerings; no deadlock', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const target = (await create({ name: 'Reverse Lock School', ...RW }).expect(201)).body.id;
      const rowLock: [string, unknown[]] = [`SELECT 1 FROM "School" WHERE "id" = $1 FOR UPDATE`, [target]];
      const nameLock = (name: string): [string, unknown[]] => [`SELECT pg_advisory_xact_lock(4213, hashtext($1))::text`, [schoolKey(name)]];
      const cases: Array<[string, [string, unknown[]], () => PromiseLike<any>, number]> = [
        ['create', nameLock('Reverse Created School'), () => create({ name: 'Reverse Created School', ...RW }), 201],
        ['import', nameLock('Reverse Imported School'), () => upload(csv([row('Reverse Imported School')])), 201],
        ['PATCH', rowLock, () => http().patch(`${S}/${target}`).set(bearer(admin)).send({ location: 'Ngoma, by the road' }), 200],
        ['setActive', rowLock, () => http().patch(`${S}/${target}/active`).set(bearer(admin)).send({ isActive: false, reason: 'Reverse lock test' }), 200],
        ['contacts', rowLock, () => putContacts(target, [{ type: 'EMAIL', value: 'reverse@x.rw' }]), 200],
        ['offerings', rowLock, () => putOfferings(target, { levels: [{ code: 'OL' }], programmes: [] }), 200],
      ];
      for (const [label, [sql, params], op, expected] of cases) {
        const holder = await pgClient();
        try {
          await holder.query('BEGIN');
          await holder.query(sql, params);   // the write will hold the directory (shared) and wait here
          const req = start(op);
          await until(`${label} holds the directory (shared)`, async () => (await directoryLocks('ShareLock', true)) === 1);
          const sync = holdSync();
          const acquired = tracked(sync.acquired);
          await until(`the sync waits behind ${label}`, async () => (await directoryLocks('ExclusiveLock', false)) === 1);
          await sleep(200);
          expect([label, acquired.settled, req.settled]).toEqual([label, false, false]);
          await holder.query('COMMIT');
          expect([label, (await req.promise).status]).toEqual([label, expected]);
          await sync.acquired;
          await sync.release();
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          await holder.end();
        }
      }
    });

    it('a sync-shaped transaction (exclusive, then a school row, then a name lock) racing PATCH, setActive and a create of the same name: all complete, none deadlocks', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const target = (await create({ name: 'Race Directory School', ...RW }).expect(201)).body.id;
      for (let round = 0; round < 3; round++) {
        const sync = p().$transaction(async (tx) => {
          await lockSchoolDirectory(tx, 'exclusive');
          await tx.$queryRaw`SELECT 1 FROM "School" WHERE "id" = ${target} FOR UPDATE`;
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(4213, hashtext(${schoolKey('Race Directory School')}))::text`;
          await tx.school.update({ where: { id: target }, data: { lastSourceSyncAt: new Date() } });
          await sleep(100);
        }, { timeout: 30_000, maxWait: 10_000 });
        const results = await Promise.all([
          sync.then(() => 'sync ok'),
          http().patch(`${S}/${target}`).set(bearer(admin)).send({ name: `Race Directory School ${round}` }).then((r) => r.status),
          http().patch(`${S}/${target}/active`).set(bearer(admin)).send({ isActive: round % 2 === 1, reason: 'Race test' }).then((r) => r.status),
          create({ name: 'Race Directory School', ...RW, confirmPossibleDuplicate: true }).then((r) => r.status),
        ]);
        expect(results).toEqual(['sync ok', 200, 200, 201]);
      }
    });
  });
});
