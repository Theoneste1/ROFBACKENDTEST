/**
 * School administration PR D — bulk school import (owner-approved 2026-11-11).
 *
 *   GET  /admin/schools/import-template?format=csv|xlsx
 *   POST /admin/schools/import?dryRun&confirmPossibleDuplicates&reviewToken    (.csv / .xlsx)
 *
 * All-or-nothing; exactly the single-create rules; create-only; possible duplicates need an
 * explicit, token-bound confirmation that is re-checked under the locks; every school and audit
 * record in one transaction; refusals never write CREATE_SCHOOL. Shared locks for create, import,
 * PATCH and setActive: the directory lock (shared, S1), the edited school's row, then sorted name
 * locks, then sorted code locks. Names may repeat (M12): rows are mapped back to schools by id.
 */
import { deflateRawSync } from 'node:zlib';

import ExcelJS from 'exceljs';
import pg from 'pg';

import { AuditService } from '../src/audit/audit.service.js';
import { SchoolImportService } from '../src/schools/import/school-import.service.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

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

const HEADER = ['name', 'countryCode', 'code', 'province', 'district', 'sector', 'location', 'ownership'];
const NGOMA = ['Southern Province', 'Huye', 'Ngoma'];
const csvOf = (rows: Array<Array<string | null>>) => [HEADER, ...rows].map((r) => r.map((v) => (v === null ? '' : `"${String(v).replace(/"/g, '""')}"`)).join(',')).join('\r\n');
/** A row: name, country, code, province, district, sector, location, ownership. */
const R = (name: string, o: { country?: string; code?: string; place?: string[] | null; location?: string; ownership?: string } = {}) =>
  [name, o.country ?? '', o.code ?? '', ...(o.place === null ? ['', '', ''] : (o.place ?? NGOMA)), o.location ?? '', o.ownership ?? ''];

describe('Bulk school import (PR D)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, teacher: string, headCoach: string, coach: string, student: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const S = '/api/v1/admin/schools';
  const I = `${S}/import`;
  /** The error code of an error response (a school's own `code` field on a success is not an error code). */
  const errorCode = (r: { status: number; body?: any }) => (r.status >= 400 ? r.body?.code ?? null : null);
  const status = async (req: any) => { const r = await req; return [r.status, errorCode(r)]; };
  const upload = (body: string | Buffer, query: object = {}, opts: { token?: string; filename?: string } = {}) =>
    http().post(I).query(query).set(bearer(opts.token ?? admin))
      .attach('file', Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), { filename: opts.filename ?? (Buffer.isBuffer(body) ? 'schools.xlsx' : 'schools.csv') });
  const schoolCount = () => p().school.count();
  async function xlsxOf(rows: unknown[][]) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Schools');
    [HEADER, ...rows].forEach((r, i) => r.forEach((v, j) => { if (v !== null && v !== '' && v !== undefined) ws.getCell(i + 1, j + 1).value = v as ExcelJS.CellValue; }));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    student = await login(ctx, 'student.j');
    const official = (name: string, code: string, province: string, district: string, sector: string) => p().school.create({ data: {
      name, code, nameKey: name.toLowerCase(), location: `${sector}, ${district}`, province, district, sector, ownership: 'PUBLIC', source: 'OFFICIAL_LIST',
    } });
    await official('gs ngoma official', '220001', ...NGOMA as [string, string, string]);
    await official('gs tumba official', '220002', 'Southern Province', 'Huye', 'Tumba');
    await official('gs kacyiru official', '110001', 'Kigali City', 'Gasabo', 'Kacyiru');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    for (const [username, role] of [['si.teacher', 'TEACHER'], ['si.head', 'HEAD_COACH'], ['si.super', 'SUPER_ADMIN']] as const) {
      await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
    }
    [teacher, headCoach, superAdmin] = await Promise.all(['si.teacher', 'si.head', 'si.super'].map((u) => login(ctx, u)));
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  // ─── Authorization and templates ───────────────────────────────────────────

  it('schools.manage only: every other role 403, anonymous 401 — for the template and the import', async () => {
    const before = await schoolCount();
    for (const token of [teacher, headCoach, coach, student]) {
      expect((await http().get(`${S}/import-template`).set(bearer(token))).status).toBe(403);
      expect((await upload(csvOf([R('Nope School')]), {}, { token })).status).toBe(403);
    }
    expect((await http().get(`${S}/import-template`)).status).toBe(401);
    expect((await http().post(I).attach('file', Buffer.from(csvOf([R('Nope School')])), 'x.csv')).status).toBe(401);
    expect(await schoolCount()).toBe(before);
  });

  it('templates: CSV (the header row) and XLSX (Schools header only + Instructions); uploading either imports nothing', async () => {
    const c = await http().get(`${S}/import-template`).set(bearer(admin)).expect(200);
    expect(c.headers['content-type']).toMatch(/text\/csv/);
    expect(c.headers['content-disposition']).toMatch(/schools-import-template\.csv/);
    expect(c.text.replace(/^﻿/, '').trim()).toBe(HEADER.join(','));
    const x = await http().get(`${S}/import-template`).query({ format: 'xlsx' }).set(bearer(superAdmin)).buffer(true)
      .parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (d: Buffer) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.body);
    expect(wb.worksheets.map((s) => s.name)).toEqual(['Schools', 'Instructions']);
    expect(await status(upload(c.text))).toEqual([400, 'EMPTY_IMPORT']);
    expect(await status(upload(x.body))).toEqual([400, 'EMPTY_IMPORT']);
    expect(await status(http().get(`${S}/import-template`).query({ format: 'pdf' }).set(bearer(admin)))).toEqual([400, 'VALIDATION_FAILED']);
  });

  // ─── Dry run, success, all-or-nothing ──────────────────────────────────────

  it('dry run: every problem per row, nothing created, an audit summary with the cleaned file name', async () => {
    const before = await schoolCount();
    const file = csvOf([
      R('Dry Valid School'),
      R('Dry Kenya School', { country: 'KE', place: null, location: 'Nairobi' }),
      R('Dry Bad Prefix', { code: '120555' }),
      R('Dry Bad Place', { place: ['Southern Province', 'Huye', 'Nowhere'] }),
      R('gs ngoma official'),
      R('Dry Taken Code', { code: '220001' }),
      R('Dry Valid School'),
      R('Dry Bad Ownership', { ownership: 'CHARITY' }),
      R('gs kacyiru official'),
    ]);
    const res = await upload(file, { dryRun: true }, { filename: '../../evil/dir/schools-batch.csv' }).expect(200);
    // M12: names repeat. Row 6 has an existing school's exact name in the same district → a possible
    // duplicate (not an error); row 10 has one from another district → simply a valid row.
    expect(res.body).toMatchObject({
      dryRun: true, totalRows: 9, valid: 4, failed: 5, canImport: false,
      possibleDuplicates: [{ row: 6, name: 'gs ngoma official', candidates: [expect.objectContaining({ name: 'gs ngoma official', code: '220001' })] }],
    });
    expect(res.body.reviewToken).toBeUndefined();   // rows have errors: nothing can be confirmed yet
    expect(res.body.errors.map((e: any) => [e.row, e.errors.join(' ')])).toEqual([
      [4, 'Code 120555 belongs to Kigali City, not Southern Province.'],
      [5, 'Nowhere, Huye, Southern Province is not a place in the official directory.'],
      [7, 'A school with this code already exists.'],
      [8, 'same name as row 2 in the same district (a duplicate within this file).'],
      [9, expect.stringMatching(/ownership must be one of/)],
    ]);
    expect(await schoolCount()).toBe(before);
    const log = await p().auditLog.findFirstOrThrow({ where: { action: 'IMPORT_SCHOOLS_DRY_RUN' }, orderBy: { createdAt: 'desc' } });
    expect(log.metadata).toMatchObject({ fileName: 'schools-batch.csv', fileSha256: expect.stringMatching(/^[0-9a-f]{64}$/), totalRows: 9, failed: 5 });
    expect(JSON.stringify(log.metadata)).not.toContain('evil');
  });

  it('a valid CSV imports every row atomically: ADMIN, active, the importer as creator, single-create defaults; one CREATE_SCHOOL per school + a summary', async () => {
    const before = await schoolCount();
    const res = await upload(csvOf([
      R('Import One School', { code: '220501', ownership: 'PRIVATE' }),
      R('Import Two School'),
      R('Import Kenya Academy', { country: 'ke', place: null, location: 'Mombasa' }),
    ])).expect(201);
    expect(res.body).toMatchObject({ dryRun: false, totalRows: 3, created: 3, confirmedPossibleDuplicates: 0 });
    expect(res.body.schools.map((s: any) => [s.row, s.name, s.code])).toEqual([[2, 'Import One School', '220501'], [3, 'Import Two School', null], [4, 'Import Kenya Academy', null]]);
    expect(await schoolCount()).toBe(before + 3);
    const two = await p().school.findFirstOrThrow({ where: { name: 'Import Two School' } });
    expect(two).toMatchObject({ source: 'ADMIN', isActive: true, createdById: ctx.ids.admin, ownership: null, location: 'Ngoma, Huye', countryCode: 'RW', nameKey: 'import two school' });
    expect(await p().school.findFirstOrThrow({ where: { name: 'Import Kenya Academy' } })).toMatchObject({ countryCode: 'KE', province: null, location: 'Mombasa' });
    const creates = await p().auditLog.findMany({ where: { action: 'CREATE_SCHOOL', metadata: { path: ['importId'], equals: res.body.importId } } });
    expect(creates).toHaveLength(3);
    expect(creates.find((c) => c.entityId === two.id)!.metadata).toMatchObject({ via: 'IMPORT', row: 3, fileName: 'schools.csv', school: { name: 'Import Two School', source: 'ADMIN', isActive: true } });
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'IMPORT_SCHOOLS', metadata: { path: ['importId'], equals: res.body.importId } } })).metadata)
      .toMatchObject({ created: 3, totalRows: 3, format: 'csv' });
    // The official directory is unchanged: imports never add OFFICIAL_LIST rows.
    expect(await p().school.count({ where: { source: 'OFFICIAL_LIST' } })).toBe(3);
  });

  it('XLSX works the same (numbers as codes, blank rows and whitespace-only cells ignored); a formula cell refuses the whole file', async () => {
    const ok = await upload(await xlsxOf([
      ['Xlsx One School', null, 220502, ...NGOMA, '  ', 'PUBLIC'],
      [null, null, null, null, null, null, null, null],
      ['Xlsx Two School', 'RW', null, ...NGOMA, null, null],
    ])).expect(201);
    expect(ok.body.schools.map((s: any) => [s.row, s.code])).toEqual([[2, '220502'], [4, null]]);
    const before = await schoolCount();
    const bad = await upload(await xlsxOf([
      ['Xlsx Three School', null, null, ...NGOMA, null, null],
      [{ formula: 'CONCAT("Xlsx ","Four")', result: 'Xlsx Four' }, null, null, ...NGOMA, null, null],
    ])).expect(422);
    expect(bad.body.details.errors).toEqual([{ row: 3, errors: [expect.stringMatching(/Formulas are not imported.*cell A3/)] }]);
    expect(await schoolCount()).toBe(before);
  });

  it('all-or-nothing: one invalid row → 422, no school, no CREATE_SCHOOL, an IMPORT_SCHOOLS_REFUSED record', async () => {
    const before = await schoolCount();
    const creates = await p().auditLog.count({ where: { action: 'CREATE_SCHOOL' } });
    const res = await upload(csvOf([R('Atomic Good One'), R('Atomic Good Two'), R('Atomic Bad', { code: '22' })])).expect(422);
    expect(res.body).toMatchObject({ code: 'IMPORT_INVALID', details: { errors: [{ row: 4, errors: ['code must be exactly 6 digits.'] }] } });
    expect(await schoolCount()).toBe(before);
    expect(await p().auditLog.count({ where: { action: 'CREATE_SCHOOL' } })).toBe(creates);
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'IMPORT_SCHOOLS_REFUSED' }, orderBy: { createdAt: 'desc' } })).metadata)
      .toMatchObject({ reason: 'IMPORT_INVALID', failed: 1, totalRows: 3, fileName: 'schools.csv' });
  });

  it('create-only: an existing code is a row error; an existing name nearby is a possible duplicate (M12: names repeat); existing schools are never changed', async () => {
    const existing = await p().school.findFirstOrThrow({ where: { name: 'Import One School' } });
    const before = await schoolCount();
    const res = await upload(csvOf([R('Import One School', { location: 'Changed' }), R('Other New School', { code: '220501' })])).expect(422);
    expect(res.body.details.errors).toEqual([{ row: 3, errors: ['A school with this code already exists.'] }]);
    const dup = await upload(csvOf([R('Import One School', { location: 'Changed' })])).expect(409);
    expect(dup.body).toMatchObject({
      code: 'POSSIBLE_DUPLICATES_UNCONFIRMED',
      details: { possibleDuplicates: [{ row: 2, candidates: [expect.objectContaining({ id: existing.id })] }] },
    });
    expect(await schoolCount()).toBe(before);
    expect(await p().school.findUniqueOrThrow({ where: { id: existing.id } })).toEqual(existing);
  });

  // ─── Parity with POST /admin/schools ───────────────────────────────────────

  it('exactly the single-create rules: the same inputs are accepted / refused with the same messages', async () => {
    const cases: Array<{ body: Record<string, string>; row: string[] }> = [
      { body: { name: 'Parity Bad Format', code: '2205', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }, row: R('Parity Bad Format', { code: '2205' }) },
      { body: { name: 'Parity Bad Prefix', code: '320777', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }, row: R('Parity Bad Prefix', { code: '320777' }) },
      { body: { name: 'Parity No Place' }, row: R('Parity No Place', { place: null }) },
      { body: { name: 'Parity Bad Place', province: NGOMA[0], district: NGOMA[1], sector: 'Nowhere' }, row: R('Parity Bad Place', { place: [NGOMA[0], NGOMA[1], 'Nowhere'] }) },
      { body: { name: 'Parity Kenya Code', countryCode: 'KE', location: 'Nairobi', code: '220778' }, row: R('Parity Kenya Code', { country: 'KE', place: null, location: 'Nairobi', code: '220778' }) },
      { body: { name: 'Parity Kenya Place', countryCode: 'KE', location: 'Nairobi', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }, row: R('Parity Kenya Place', { country: 'KE', location: 'Nairobi' }) },
      { body: { name: 'Parity Kenya No Location', countryCode: 'KE' }, row: R('Parity Kenya No Location', { country: 'KE', place: null }) },
      { body: { name: 'Parity Bad Country', countryCode: 'XX', location: 'Somewhere' }, row: R('Parity Bad Country', { country: 'XX', place: null, location: 'Somewhere' }) },
      { body: { name: '!!', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }, row: R('!!') },
      { body: { name: 'Parity Taken Code', code: '220002', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }, row: R('Parity Taken Code', { code: '220002' }) },
      { body: { name: 'Parity Bad Ownership', ownership: 'CHARITY', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }, row: R('Parity Bad Ownership', { ownership: 'CHARITY' }) },
    ];
    for (const c of cases) {
      const single = await http().post(S).set(bearer(admin)).send(c.body);
      const singleMessages = single.body.code === 'VALIDATION_FAILED' ? single.body.details : [single.body.message];
      const dry = await upload(csvOf([c.row]), { dryRun: true }).expect(200);
      expect([c.body.name, single.status >= 400, dry.body.errors[0]?.errors]).toEqual([c.body.name, true, singleMessages]);
    }
    // An existing name in the same district (M12: names repeat): a possible duplicate for both, with the same candidates.
    const dupSingle = await http().post(S).set(bearer(admin)).send({ name: 'gs tumba official', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }).expect(409);
    const dupDry = await upload(csvOf([R('gs tumba official')]), { dryRun: true }).expect(200);
    expect(dupSingle.body.code).toBe('POSSIBLE_DUPLICATE');
    expect(dupDry.body.errors).toEqual([]);
    expect(dupDry.body.possibleDuplicates[0].candidates.map((c: any) => c.id)).toEqual(dupSingle.body.details.candidates.map((c: any) => c.id));
    // Accepted alike, with the same defaults.
    const viaCreate = (await http().post(S).set(bearer(admin)).send({ name: 'Parity Accept A', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }).expect(201)).body;
    await upload(csvOf([R('Parity Accept B')])).expect(201);
    const viaImport = await p().school.findFirstOrThrow({ where: { name: 'Parity Accept B' } });
    for (const k of ['countryCode', 'province', 'district', 'sector', 'location', 'ownership', 'source', 'isActive', 'code'] as const) {
      expect([k, viaImport[k]]).toEqual([k, viaCreate[k]]);
    }
  });

  // ─── Possible duplicates and the review token ──────────────────────────────

  describe('possible duplicates: explicit, token-bound confirmation, re-checked under the locks', () => {
    let target: string;
    beforeAll(async () => {
      target = (await http().post(S).set(bearer(admin)).send({ name: 'Lycée de Huye', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }).expect(201)).body.id;
    });
    const dupFile = (extra = '') => csvOf([R('LYCEE DE HUYE' + extra), R(`Dup Free School${extra}`)]);

    it('unconfirmed → 409 with candidates and a token; the dry run shows the same; confirming with that token imports and audits the confirmation', async () => {
      const before = await schoolCount();
      const refused = await upload(dupFile()).expect(409);
      expect(refused.body).toMatchObject({ code: 'POSSIBLE_DUPLICATES_UNCONFIRMED', details: {
        possibleDuplicates: [{ row: 2, name: 'LYCEE DE HUYE', candidates: [expect.objectContaining({ id: target, name: 'Lycée de Huye', district: 'Huye', isActive: true })] }],
        reviewToken: expect.any(String), reviewExpiresAt: expect.any(String),
      } });
      expect(await schoolCount()).toBe(before);
      const dry = await upload(dupFile(), { dryRun: true }).expect(200);
      expect(dry.body).toMatchObject({ canImport: true, possibleDuplicates: [{ row: 2 }], reviewToken: expect.any(String) });

      expect(await status(upload(dupFile(), { confirmPossibleDuplicates: true }))).toEqual([400, 'REVIEW_TOKEN_REQUIRED']);
      const ok = await upload(dupFile(), { confirmPossibleDuplicates: true, reviewToken: dry.body.reviewToken }).expect(201);
      expect(ok.body).toMatchObject({ created: 2, confirmedPossibleDuplicates: 1 });
      const created = await p().school.findFirstOrThrow({ where: { name: 'LYCEE DE HUYE' } });
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'CREATE_SCHOOL', entityId: created.id } })).metadata)
        .toMatchObject({ confirmedPossibleDuplicate: true, possibleDuplicates: [expect.objectContaining({ id: target })] });
    });

    it('the token is bound to the Administrator and the file: another Administrator or another file → INVALID_REVIEW_TOKEN', async () => {
      await http().post(S).set(bearer(admin)).send({ name: 'Token Bound School', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }).expect(201);
      const fileB = csvOf([R('TOKEN BOUND SCHOOL'), R('Token Free B')]);
      const fileC = csvOf([R('TOKEN BOUND SCHOOL'), R('Token Free C')]);
      const dry = await upload(fileB, { dryRun: true }).expect(200);
      expect(dry.body.reviewToken).toEqual(expect.any(String));
      expect(await status(upload(fileB, { confirmPossibleDuplicates: true, reviewToken: dry.body.reviewToken }, { token: superAdmin }))).toEqual([400, 'INVALID_REVIEW_TOKEN']);
      expect(await status(upload(fileC, { confirmPossibleDuplicates: true, reviewToken: dry.body.reviewToken }))).toEqual([400, 'INVALID_REVIEW_TOKEN']);
      expect(await status(upload(fileB, { confirmPossibleDuplicates: true, reviewToken: dry.body.reviewToken + 'x' }))).toEqual([400, 'INVALID_REVIEW_TOKEN']);
      expect(await p().school.count({ where: { name: { in: ['Token Free B', 'Token Free C'] } } })).toBe(0);
      // The rightful Administrator, same file: imported.
      await upload(fileB, { confirmPossibleDuplicates: true, reviewToken: dry.body.reviewToken }).expect(201);
    });

    it('any change since the review → 409 IMPORT_REVIEW_OUTDATED with fresh candidates, nothing created: a candidate recoded, deactivated, renamed; a new candidate; expiry', async () => {
      const file = csvOf([R('Ecole Revue')]);
      const cand = (await http().post(S).set(bearer(admin)).send({ name: 'École Revue', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }).expect(201)).body.id;
      const outdated = async (change: () => Promise<unknown>) => {
        const dry = await upload(file, { dryRun: true }).expect(200);
        await change();
        const before = await schoolCount();
        const res = await upload(file, { confirmPossibleDuplicates: true, reviewToken: dry.body.reviewToken }).expect(409);
        expect(res.body.code).toBe('IMPORT_REVIEW_OUTDATED');
        expect(res.body.details.reviewToken).not.toBe(dry.body.reviewToken);
        expect(await schoolCount()).toBe(before);
        return res.body.details;
      };
      await outdated(() => http().patch(`${S}/${cand}`).set(bearer(admin)).send({ code: '220601', reason: 'Code assigned' }).expect(200));
      await outdated(() => http().patch(`${S}/${cand}/active`).set(bearer(admin)).send({ isActive: false, reason: 'closed' }).expect(200));
      await outdated(() => http().patch(`${S}/${cand}`).set(bearer(admin)).send({ name: 'ECOLE REVUE' }).expect(200));
      const fresh = await outdated(() => http().post(S).set(bearer(admin)).send({ name: 'Ecole-Revue', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2], confirmPossibleDuplicate: true }).expect(201));
      expect(fresh.possibleDuplicates[0].candidates).toHaveLength(2);
      // Expiry: the same, unchanged review after 15 minutes.
      const importer = ctx.app.get(SchoolImportService);
      const dry = await upload(file, { dryRun: true }).expect(200);
      const real = importer.now;
      importer.now = () => new Date(Date.now() + 16 * 60_000);
      try {
        expect(await status(upload(file, { confirmPossibleDuplicates: true, reviewToken: dry.body.reviewToken }))).toEqual([409, 'IMPORT_REVIEW_OUTDATED']);
      } finally { importer.now = real; }
      // With the fresh review it imports.
      const again = await upload(file, { dryRun: true }).expect(200);
      await upload(file, { confirmPossibleDuplicates: true, reviewToken: again.body.reviewToken }).expect(201);
    });

    it('a duplicate within the file is an error that cannot be confirmed', async () => {
      const res = await upload(csvOf([R('Twin School'), R('TWIN SCHOOL!')]), { confirmPossibleDuplicates: true, reviewToken: 'x.y' });
      expect(res.status).toBe(400);   // the token is checked first …
      const dry = await upload(csvOf([R('Twin School'), R('TWIN SCHOOL!')]), { dryRun: true }).expect(200);
      expect(dry.body.errors).toEqual([{ row: 3, errors: ['same name as row 2 in the same district (a duplicate within this file).'] }]);   // … and the row is refused regardless
    });
  });

  // ─── Usability, exports, atomicity, limits ──────────────────────────────────

  it('imported schools are usable at once: registration and invitation by code, a student claim, a Teacher assignment', async () => {
    await upload(csvOf([R('Usable Import School', { code: '220880' })])).expect(201);
    const school = await p().school.findUniqueOrThrow({ where: { code: '220880' } });
    await http().post('/api/v1/auth/register/student').send({
      firstName: 'U', lastName: 'Reg', username: 'si.reg', email: 'si.reg@test.local', password: 'Secret123', gradeLevel: 'S2', homeLocation: 'Huye', schoolCode: '220880',
    }).expect(201);
    expect((await p().user.findUniqueOrThrow({ where: { username: 'si.reg' } })).schoolId).toBe(school.id);
    const inv = await http().post('/api/v1/admin/users/invite').set(bearer(admin)).send({ firstName: 'I', lastName: 'Nv', email: 'si.inv@test.local', gradeLevel: 'S2', schoolCode: '220880' }).expect(201);
    expect(inv.body.user.school?.id ?? (await p().user.findUniqueOrThrow({ where: { email: 'si.inv@test.local' } })).schoolId).toBe(school.id);
    // A student's own claim for the imported school.
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const s = await p().user.create({ data: { username: 'si.claimer', firstName: 'C', lastName: 'L', email: 'si.claimer@test.local', role: 'STUDENT', passwordHash: hash, activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior } });
    await p().studentEnrollment.create({ data: { studentId: s.id, academicYearId: ctx.ids.year, gradeLevel: 'S2', divisionId: ctx.ids.junior } });
    await http().post('/api/v1/me/school-affiliation').set(bearer(await login(ctx, 'si.claimer'))).send({ schoolCode: '220880' }).expect(201);
    expect((await p().user.findUniqueOrThrow({ where: { id: s.id } })).schoolId).toBe(school.id);
    const teacherId = (await p().user.findUniqueOrThrow({ where: { username: 'si.teacher' } })).id;
    await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: school.id }).expect(201);
  });

  it('a formula-like school name is kept as typed and neutralised in CSV exports', async () => {
    await upload(csvOf([R('=SUM(A1)')])).expect(201);
    const school = await p().school.findFirstOrThrow({ where: { name: '=SUM(A1)' } });
    await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'F', lastName: 'Ormula', username: 'si.formula', email: 'si.formula@test.local', password: 'Str0ng!Passw0rd', role: 'STUDENT', gradeLevel: 'S2', schoolId: school.id,
    }).expect(201);
    const report = await http().get('/api/v1/admin/reports/students.csv').query({ academicYearId: 'all' }).set(bearer(admin)).expect(200);
    expect(report.text).toContain("'=SUM(A1)");
    expect(report.text).not.toMatch(/(^|,)"?=SUM\(A1\)/m);
  });

  it('an audit failure during the import rolls back every school', async () => {
    const audit = ctx.app.get(AuditService);
    const before = await schoolCount();
    const spy = vi.spyOn(audit, 'logMany').mockImplementationOnce(async () => { throw new Error('audit unavailable'); });
    try {
      expect((await upload(csvOf([R('Rollback One'), R('Rollback Two')]))).status).toBe(500);
    } finally { spy.mockRestore(); }
    expect(await schoolCount()).toBe(before);
    expect(await p().school.count({ where: { name: { startsWith: 'Rollback' } } })).toBe(0);
  });

  it('limits and file checks over HTTP: rows, size, type, renamed binary, zip bomb', async () => {
    const before = await schoolCount();
    const many = csvOf(Array.from({ length: 1001 }, (_, i) => R(`Many School ${i}`)));
    expect(await status(upload(many))).toEqual([400, 'TOO_MANY_ROWS']);
    // Over 1 MB: refused by the upload layer before any handler (the project's 413 PAYLOAD_TOO_LARGE, as for every upload).
    expect(await status(upload(Buffer.alloc(1024 * 1024 + 1, 0x41), {}, { filename: 'big.csv' }))).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(await status(upload(csvOf([R('Macro School')]), {}, { filename: 'schools.xlsm' }))).toEqual([415, 'UNSUPPORTED_FILE_TYPE']);
    expect(await status(upload(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), {}, { filename: 'image.csv' }))).toEqual([415, 'UNSUPPORTED_FILE_TYPE']);
    // A small zip that would unpack to 25 MB.
    const data = deflateRawSync(Buffer.alloc(25 * 1024 * 1024));
    const name = Buffer.from('xl/worksheets/sheet1.xml');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(25 * 1024 * 1024, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(25 * 1024 * 1024, 24); central.writeUInt16LE(name.length, 28);
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(30 + name.length + data.length, 16);
    expect(await status(upload(Buffer.concat([local, name, data, central, name, eocd])))).toEqual([415, 'INVALID_XLSX']);
    expect(await status(http().post(I).set(bearer(admin)))).toEqual([400, 'FILE_REQUIRED']);
    expect(await schoolCount()).toBe(before);
  });

  // ─── Concurrency (PostgreSQL in CI) ────────────────────────────────────────

  describe('concurrency: shared locks for create, import, PATCH and setActive', () => {
    const requireConcurrency = async (test: { skip: (note: string) => void }) => {
      if (await servesConcurrentConnections()) return true;
      if (process.env.CI) throw new Error('CI database must serve concurrent connections for this test.');
      test.skip('local single-connection database (prisma dev): runs in CI on PostgreSQL');
      return false;
    };
    const mk = async (name: string, code: string | null) =>
      (await http().post(S).set(bearer(admin)).send({ name, ...(code && { code }), province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }).expect(201)).body.id as string;
    const patch = (id: string, body: object) => http().patch(`${S}/${id}`).set(bearer(admin)).send({ reason: 'concurrency test', ...body }).then((r) => [r.status, errorCode(r)]);
    const codeOf = async (id: string) => (await p().school.findUniqueOrThrow({ where: { id } })).code;
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('two PATCHes swapping existing codes X and Y: BOTH 409 SCHOOL_CODE_TAKEN, neither school changes, no deadlock (both orders)', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const a = await mk('Swap School A', '220701');
      const b = await mk('Swap School B', '220702');
      for (const order of [0, 1]) {
        const calls = [() => patch(a, { code: '220702' }), () => patch(b, { code: '220701' })];
        const started = Date.now();
        const results = await Promise.all(order ? [calls[1](), calls[0]()] : [calls[0](), calls[1]()]);
        expect(results).toEqual([[409, 'SCHOOL_CODE_TAKEN'], [409, 'SCHOOL_CODE_TAKEN']]);
        expect(Date.now() - started).toBeLessThan(15_000);
        expect([await codeOf(a), await codeOf(b)]).toEqual(['220701', '220702']);
      }
      expect(await p().auditLog.count({ where: { action: 'UPDATE_SCHOOL', entityId: { in: [a, b] } } })).toBe(0);
    });

    it('two PATCHes claiming the same unused code Z: exactly one 200, one 409 SCHOOL_CODE_TAKEN; Z on exactly one school', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const a = await mk('Claim Z School A', null);
      const b = await mk('Claim Z School B', null);
      const results = await Promise.all([patch(a, { code: '220703' }), patch(b, { code: '220703' })]);
      expect(results).toEqual(expect.arrayContaining([[200, null], [409, 'SCHOOL_CODE_TAKEN']]));
      expect(await p().school.count({ where: { code: '220703' } })).toBe(1);
    });

    it('a PATCH setting code X races a create and an import using X under different names: exactly one school has X, the other gets a clear refusal', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const a = await mk('Race Patch School', null);
      const [pr, cr] = await Promise.all([
        patch(a, { code: '220704' }),
        http().post(S).set(bearer(admin)).send({ name: 'Race Create School', code: '220704', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2] }).then((r) => [r.status, errorCode(r)]),
      ]);
      // Exactly one wins: the PATCH (200) and the create is refused, or the create (201) and the PATCH is refused.
      expect([[[200, null], [409, 'SCHOOL_CODE_TAKEN']], [[409, 'SCHOOL_CODE_TAKEN'], [201, null]]]).toContainEqual([pr, cr]);
      expect(await p().school.count({ where: { code: '220704' } })).toBe(1);

      const b = await mk('Race Patch School 2', null);
      const [pr2, ir] = await Promise.all([
        patch(b, { code: '220705' }),
        upload(csvOf([R('Race Import School', { code: '220705' })])).then((r) => [r.status, errorCode(r), r.body?.details?.errors?.[0]?.errors?.[0] ?? null]),
      ]);
      // Exactly one wins: the PATCH (and the import is refused with the row error) or the import (and the PATCH is refused).
      expect([
        [[200, null], [422, 'IMPORT_INVALID', 'A school with this code already exists.']],
        [[409, 'SCHOOL_CODE_TAKEN'], [201, null, null]],
      ]).toContainEqual([pr2, ir]);
      expect(await p().school.count({ where: { code: '220705' } })).toBe(1);
    });

    it('two imports with overlapping names and codes in different orders: one imports, the other is refused, no deadlock, nothing duplicated', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const one = csvOf([R('Overlap Alpha', { code: '220711' }), R('Overlap Beta', { code: '220712' })]);
      const two = csvOf([R('Overlap Beta', { code: '220712' }), R('Overlap Alpha', { code: '220711' })]);
      const results = await Promise.all([upload(one), upload(two)].map((q) => q.then((r) => [r.status, errorCode(r)])));
      expect(results).toEqual(expect.arrayContaining([[201, null], [422, 'IMPORT_INVALID']]));
      expect(await p().school.count({ where: { name: { in: ['Overlap Alpha', 'Overlap Beta'] } } })).toBe(2);
    });

    it('a PATCH setting code X waits for a held code lock; a location-only PATCH takes no name / code lock', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const a = await mk('Held Lock School', '220720');
      const holder = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await holder.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT pg_advisory_xact_lock(4214, hashtext('220721'))`);
        await holder.query(`SELECT pg_advisory_xact_lock(4213, hashtext('held lock school'))`);
        await holder.query(`SELECT pg_advisory_xact_lock(4214, hashtext('220720'))`);
        // Not blocked: only the location changes.
        const started = Date.now();
        expect(await patch(a, { location: 'Ngoma centre' })).toEqual([200, null]);
        expect(Date.now() - started).toBeLessThan(3_000);
        // Blocked: the code changes (school key + both codes).
        let done = false;
        const recode = patch(a, { code: '220721' }).then((r) => { done = true; return r; });
        await wait(600);
        expect(done).toBe(false);
        await holder.query(`INSERT INTO "School" ("id", "name", "location", "code") VALUES (gen_random_uuid()::text, 'Held Lock Winner', 'x', '220721')`);
        await holder.query('COMMIT');
        expect(await recode).toEqual([409, 'SCHOOL_CODE_TAKEN']);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
      expect(await codeOf(a)).toBe('220720');
    });

    it('a candidate moved into the district while an import runs: the import sees it, or the move waits — never an unreviewed duplicate', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const elsewhere = (await http().post(S).set(bearer(admin)).send({ name: 'Moving School', province: 'Southern Province', district: 'Huye', sector: 'Tumba' }).expect(201)).body.id;
      await http().patch(`${S}/${elsewhere}`).set(bearer(admin)).send({ countryCode: 'KE', province: null, district: null, sector: null, location: 'Nairobi', reason: 'abroad' }).expect(200);
      const [move, imp] = await Promise.all([
        http().patch(`${S}/${elsewhere}`).set(bearer(admin)).send({ countryCode: 'RW', province: NGOMA[0], district: NGOMA[1], sector: NGOMA[2], reason: 'back', confirmPossibleDuplicate: true }).then((r) => r.status),
        upload(csvOf([R('MOVING SCHOOL!')])).then((r) => [r.status, errorCode(r)]),
      ]);
      expect(move).toBe(200);
      // Either the import ran first (no candidate yet in Huye, imported) or saw the moved school (409 unconfirmed).
      expect([[201, null], [409, 'POSSIBLE_DUPLICATES_UNCONFIRMED']]).toContainEqual(imp);
      const imported = await p().school.findFirst({ where: { name: 'MOVING SCHOOL!' } });
      if (imp[0] === 201) expect(imported).not.toBeNull(); else expect(imported).toBeNull();
    });
  });
});
