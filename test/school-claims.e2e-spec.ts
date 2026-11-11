/**
 * School administration PR C — claim resolution and the student's own claim (owner-approved
 * 2026-11-11).
 *
 *   POST /me/school-affiliation   by code / "not listed" (name + official place) / another country;
 *                                 always PENDING; 3 per rolling 24 h; 7-day cooldown per school after
 *                                 a rejection or revocation; same pending / verified school refused.
 *   POST …/:id/match              link a name-only claim to an existing school (country must match;
 *                                 a different place needs confirmDifferentPlace); stays PENDING.
 *   POST …/:id/reopen             the current REJECTED / REVOKED claim → a new PENDING one.
 *   GET  …/:id/candidates, ?hasSchool=
 *   Registration "not listed": the place is validated and kept on the PENDING claim.
 *
 * Every path keeps M10 (one current claim; its school is User.schoolId) and the current-year
 * enrolment's school equal to User.schoolId; every failure (audit included) leaves nothing behind.
 */
import pg from 'pg';

import { AuditService } from '../src/audit/audit.service.js';
import { SchoolAffiliationService } from '../src/schools/affiliations/school-affiliation.service.js';
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

const DAY = 24 * 3600_000;
const NGOMA = { schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Ngoma' };

describe('School claims (PR C)', () => {
  let ctx: TestContext;
  let admin: string, teacher: string, headCoach: string, coach: string;
  let ngoma: string, tumba: string, kacyiru: string, kenya: string, teacherId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const A = '/api/v1/admin/school-affiliations';
  const ME = '/api/v1/me/school-affiliation';
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const current = (studentId: string) => p().studentSchoolAffiliation.findMany({ where: { studentId, supersededAt: null } });
  const claimOf = async (studentId: string) => (await current(studentId))[0];
  /** M10 and enrolment synchronisation, after any operation. */
  const consistent = async (studentId: string) => {
    const claims = await current(studentId);
    const user = await p().user.findUniqueOrThrow({ where: { id: studentId } });
    expect(claims.length).toBeLessThanOrEqual(1);
    if (claims[0]) expect(claims[0].schoolId).toBe(user.schoolId);
    const enrolment = await p().studentEnrollment.findFirst({ where: { studentId, academicYearId: ctx.ids.year, status: 'ACTIVE' } });
    if (enrolment) expect(enrolment.schoolId).toBe(user.schoolId);
  };
  let seq = 0;
  /** An activated, approved student enrolled this year; with a school, a PENDING claim through the service. */
  const mkStudent = async (schoolId: string | null = null) => {
    const n = ++seq;
    const username = `sc.s${n}`;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const u = await p().user.create({ data: {
      username, firstName: 'Sc', lastName: `S${n}`, email: `${username}@test.local`, role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId,
    } });
    await p().studentEnrollment.create({ data: { studentId: u.id, academicYearId: ctx.ids.year, gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId } });
    if (schoolId) {
      await p().$transaction((tx) => ctx.app.get(SchoolAffiliationService).claim(tx, {
        studentId: u.id, schoolId, source: 'ADMIN', reason: 'NEW_CLAIM', actor: { actorId: ctx.ids.admin, actorRole: 'ADMIN' },
      }));
    }
    return { id: u.id, token: await login(ctx, username) };
  };
  const request = (token: string, body: object) => http().post(ME).set(bearer(token)).send(body);
  const decide = (claimId: string, action: 'verify' | 'reject' | 'revoke', reason = 'Checked with the school') =>
    http().post(`${A}/${claimId}/${action}`).set(bearer(admin)).send(action === 'verify' ? {} : { reason }).expect(200);
  const teacherSees = async () => (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data.map((s: any) => s.id);

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    const official = (name: string, code: string, place: object) => p().school.create({ data: {
      name, code, nameKey: name.toLowerCase(), location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST', ...place,
    } }).then((s) => s.id);
    ngoma   = await official('gs ngoma official', '220001', { province: 'Southern Province', district: 'Huye', sector: 'Ngoma' });
    tumba   = await official('gs tumba official', '220002', { province: 'Southern Province', district: 'Huye', sector: 'Tumba' });
    kacyiru = await official('gs kacyiru official', '110001', { province: 'Kigali City', district: 'Gasabo', sector: 'Kacyiru' });
    kenya = (await p().school.create({ data: { name: 'Nairobi School', nameKey: 'nairobi school', location: 'Nairobi', countryCode: 'KE', source: 'ADMIN' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'HEAD_COACH') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
    teacherId = await mk('sc.teacher', 'TEACHER');
    await mk('sc.head', 'HEAD_COACH');
    [teacher, headCoach] = await Promise.all(['sc.teacher', 'sc.head'].map((u) => login(ctx, u)));
    await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: ngoma }).expect(201);
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  // ─── Authorization ─────────────────────────────────────────────────────────

  it('POST /me/school-affiliation: students only; match / reopen / candidates: schools.manage only (every other role 403, anonymous 401)', async () => {
    const s = await mkStudent(ngoma);
    const id = (await claimOf(s.id)).id;
    for (const token of [admin, teacher, headCoach, coach]) expect(await status(request(token, { schoolCode: '220002' }))).toEqual([403, expect.any(String)]);
    expect((await http().post(ME).send({ schoolCode: '220002' })).status).toBe(401);
    const adminRoutes: Array<[string, string, object]> = [
      ['post', `${A}/${id}/match`, { schoolId: tumba }], ['post', `${A}/${id}/reopen`, { reason: 'test reason' }], ['get', `${A}/${id}/candidates`, {}],
    ];
    for (const token of [teacher, headCoach, coach, s.token]) {
      for (const [m, url, b] of adminRoutes) expect([url, await status((http() as any)[m](url).set(bearer(token)).send(b))]).toEqual([url, [403, expect.any(String)]]);
    }
    for (const [m, url, b] of adminRoutes) expect([url, (await (http() as any)[m](url).send(b)).status]).toEqual([url, 401]);
    expect(await claimOf(s.id)).toMatchObject({ id, schoolId: ngoma, status: 'PENDING' });   // nothing changed
  });

  // ─── The student's own claim ──────────────────────────────────────────────

  describe('student requests', () => {
    it('by code: a PENDING STUDENT_REQUEST claim; User.schoolId and this year\'s enrolment follow; invisible to Teachers until verified', async () => {
      const s = await mkStudent();
      const res = await request(s.token, { schoolCode: '220001' }).expect(201);
      expect(res.body.current).toMatchObject({ status: 'PENDING', school: { id: ngoma } });
      expect(await claimOf(s.id)).toMatchObject({ schoolId: ngoma, status: 'PENDING', source: 'STUDENT_REQUEST', createdById: s.id });
      await consistent(s.id);
      expect((await p().user.findUniqueOrThrow({ where: { id: s.id } })).schoolId).toBe(ngoma);
      expect(await teacherSees()).not.toContain(s.id);
      await decide((await claimOf(s.id)).id, 'verify');
      expect(await teacherSees()).toContain(s.id);
    });

    it('"not listed": name + official place kept on a claim without a school; an exact unique official name in that sector is linked (still PENDING); another country is never matched', async () => {
      const a = await mkStudent();
      await request(a.token, { schoolName: 'Lycée Pas Listé', ...NGOMA }).expect(201);
      expect(await claimOf(a.id)).toMatchObject({
        schoolId: null, claimedName: 'Lycée Pas Listé', claimedCountry: 'RW', claimedProvince: 'Southern Province', claimedDistrict: 'Huye', claimedSector: 'Ngoma', status: 'PENDING',
      });
      await consistent(a.id);
      const b = await mkStudent();
      await request(b.token, { schoolName: 'GS NGOMA OFFICIAL', ...NGOMA }).expect(201);
      expect(await claimOf(b.id)).toMatchObject({ schoolId: ngoma, claimedName: 'GS NGOMA OFFICIAL', status: 'PENDING' });
      const c = await mkStudent();
      await request(c.token, { schoolName: 'GS NGOMA OFFICIAL', schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Tumba' }).expect(201);
      expect(await claimOf(c.id)).toMatchObject({ schoolId: null });   // the official one is in another sector
      const d = await mkStudent();
      await request(d.token, { country: 'KE', schoolName: 'Nairobi School' }).expect(201);
      expect(await claimOf(d.id)).toMatchObject({ schoolId: null, claimedName: 'Nairobi School', claimedCountry: 'KE', status: 'PENDING' });
      for (const s of [b, c, d]) await consistent(s.id);
    });

    it('body rules and school rules: each refusal writes nothing', async () => {
      const s = await mkStudent();
      const before = await p().studentSchoolAffiliation.count();
      expect(await status(request(s.token, { schoolCode: '220001', country: 'KE' }))).toEqual([400, 'SCHOOL_CODE_RWANDA_ONLY']);
      expect(await status(request(s.token, { schoolCode: '220001', schoolName: 'X School' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(request(s.token, { schoolName: 'X School' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(request(s.token, { schoolName: 'X School', schoolProvince: 'Southern Province' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(request(s.token, { country: 'KE', schoolName: 'X School', schoolDistrict: 'Huye' }))).toEqual([400, 'SCHOOL_DIRECTORY_RWANDA_ONLY']);
      expect(await status(request(s.token, { schoolName: 'X School', schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Nowhere' }))).toEqual([400, 'UNKNOWN_SCHOOL_LOCATION']);
      expect(await status(request(s.token, { schoolCode: '229999' }))).toEqual([400, 'UNKNOWN_SCHOOL_CODE']);
      expect(await status(request(s.token, { schoolCode: '22000' }))).toEqual([400, 'VALIDATION_FAILED']);
      expect(await status(request(s.token, { country: 'XX', schoolName: 'X School' }))).toEqual([400, 'VALIDATION_FAILED']);
      const closed = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'Claims Closed School', code: '220777', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }).expect(201)).body.id;
      await http().patch(`/api/v1/admin/schools/${closed}/active`).set(bearer(admin)).send({ isActive: false, reason: 'closed' }).expect(200);
      expect(await status(request(s.token, { schoolCode: '220777' }))).toEqual([409, 'SCHOOL_INACTIVE']);
      expect(await p().studentSchoolAffiliation.count()).toBe(before);
      expect((await p().user.findUniqueOrThrow({ where: { id: s.id } })).schoolId).toBeNull();
    });

    it('the same school already pending or verified is refused; leaving a verified school is allowed — its claim ends (audited as VERIFIED) and Teachers lose the student', async () => {
      const s = await mkStudent();
      await request(s.token, { schoolCode: '220001' }).expect(201);
      expect(await status(request(s.token, { schoolCode: '220001' }))).toEqual([409, 'CLAIM_ALREADY_PENDING']);
      expect(await status(request(s.token, { schoolName: 'gs ngoma official', ...NGOMA }))).toEqual([409, 'CLAIM_ALREADY_PENDING']);   // auto-linked to the same school
      const verified = await claimOf(s.id);
      await decide(verified.id, 'verify');
      expect(await status(request(s.token, { schoolCode: '220001' }))).toEqual([409, 'ALREADY_VERIFIED']);
      expect(await teacherSees()).toContain(s.id);

      await request(s.token, { schoolCode: '110001' }).expect(201);
      expect(await claimOf(s.id)).toMatchObject({ schoolId: kacyiru, status: 'PENDING' });
      expect(await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: verified.id } })).toMatchObject({ status: 'VERIFIED', supersedeReason: 'NEW_CLAIM' });
      const ended = await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', entityId: verified.id } });
      expect(ended.metadata).toMatchObject({ reason: 'NEW_CLAIM', previous: { status: 'VERIFIED' } });
      const created = await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_CREATED', entityId: (await claimOf(s.id)).id } });
      expect(created.metadata).toMatchObject({ schoolId: kacyiru, source: 'STUDENT_REQUEST', status: 'PENDING' });
      expect(await teacherSees()).not.toContain(s.id);
      await consistent(s.id);
    });

    it('limit: 3 student requests per rolling 24 hours (429 with retryAfter); refused requests and other paths do not count; the window frees a slot', async () => {
      const s = await mkStudent(kacyiru);   // an Administrator-made claim: not counted
      await request(s.token, { schoolCode: '220001' }).expect(201);
      expect(await status(request(s.token, { schoolCode: '220001' }))).toEqual([409, 'CLAIM_ALREADY_PENDING']);   // not counted
      await request(s.token, { schoolCode: '220002' }).expect(201);
      await request(s.token, { country: 'KE', schoolName: 'Mombasa Academy' }).expect(201);
      const fourth = await request(s.token, { schoolCode: '110001' }).expect(429);
      expect(fourth.body).toMatchObject({ code: 'CLAIM_LIMIT_REACHED', details: { retryAfter: expect.any(String) } });
      expect(await claimOf(s.id)).toMatchObject({ schoolId: null, claimedName: 'Mombasa Academy' });   // unchanged
      const oldest = await p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: s.id, source: 'STUDENT_REQUEST' }, orderBy: { createdAt: 'asc' } });
      expect(new Date(fourth.body.details.retryAfter).getTime()).toBe(oldest.createdAt.getTime() + DAY);
      await p().studentSchoolAffiliation.update({ where: { id: oldest.id }, data: { createdAt: new Date(Date.now() - DAY - 1000) } });
      await request(s.token, { schoolCode: '110001' }).expect(201);
      await consistent(s.id);
    });

    it('cooldown: 7 days after a rejection or revocation of the SAME school — also after moving away and back; other schools stay allowed; name-only identity compares the place', async () => {
      const s = await mkStudent();
      await request(s.token, { schoolCode: '220001' }).expect(201);
      const rejected = await claimOf(s.id);
      await decide(rejected.id, 'reject', 'Not on the school register');
      const refused = await request(s.token, { schoolCode: '220001' }).expect(429);
      expect(refused.body).toMatchObject({ code: 'CLAIM_COOLDOWN', details: { schoolId: ngoma } });
      await request(s.token, { schoolCode: '220002' }).expect(201);                                   // another school: allowed
      expect(await status(request(s.token, { schoolCode: '220001' }))).toEqual([429, 'CLAIM_COOLDOWN']);   // moving away does not reset it
      await p().studentSchoolAffiliation.update({ where: { id: rejected.id }, data: { decidedAt: new Date(Date.now() - 7 * DAY - 1000) } });
      await request(s.token, { schoolCode: '220001' }).expect(201);

      // Revocation, too.
      const r = await mkStudent();
      await request(r.token, { schoolCode: '110001' }).expect(201);
      const claim = await claimOf(r.id);
      await decide(claim.id, 'verify');
      await decide(claim.id, 'revoke', 'Left the school');
      expect(await status(request(r.token, { schoolCode: '110001' }))).toEqual([429, 'CLAIM_COOLDOWN']);

      // Name-only: the same name in the same place (any spelling) is cooled down; another sector is not.
      const n = await mkStudent();
      await request(n.token, { schoolName: 'École Inconnue', ...NGOMA }).expect(201);
      await decide((await claimOf(n.id)).id, 'reject', 'No such school');
      expect(await status(request(n.token, { schoolName: 'ECOLE INCONNUE', ...NGOMA }))).toEqual([429, 'CLAIM_COOLDOWN']);
      await request(n.token, { schoolName: 'École Inconnue', schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Tumba' }).expect(201);
      for (const x of [s, r, n]) await consistent(x.id);
    });
  });

  // ─── Administrator matching ────────────────────────────────────────────────

  describe('match', () => {
    it('links a name-only claim to an existing school: PENDING, original source kept, entered details copied, student and enrolment moved, old claim RESOLVED; Teachers only after verification', async () => {
      const s = await mkStudent();
      await request(s.token, { schoolName: 'GS Ngoma Annexe', ...NGOMA }).expect(201);
      const nameOnly = await claimOf(s.id);
      const annexe = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'GS Ngoma Annexe', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }).expect(201)).body.id;
      const candidates = (await http().get(`${A}/${nameOnly.id}/candidates`).set(bearer(admin)).expect(200)).body;
      expect(candidates.map((c: any) => c.id)).toEqual([annexe]);
      expect((await http().get(A).query({ hasSchool: false, status: 'PENDING', limit: 100 }).set(bearer(admin)).expect(200)).body.data.map((c: any) => c.id)).toContain(nameOnly.id);

      const res = await http().post(`${A}/${nameOnly.id}/match`).set(bearer(admin)).send({ schoolId: annexe, note: 'Same school, new record' }).expect(200);
      expect(res.body).toMatchObject({
        status: 'PENDING', source: 'STUDENT_REQUEST', school: { id: annexe }, createdBy: { id: ctx.ids.admin },
        claimedName: 'GS Ngoma Annexe', claimedSector: 'Ngoma',
      });
      expect(await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: nameOnly.id } })).toMatchObject({ supersedeReason: 'RESOLVED', supersededById: ctx.ids.admin });
      expect((await p().user.findUniqueOrThrow({ where: { id: s.id } })).schoolId).toBe(annexe);
      await consistent(s.id);
      const log = await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_RESOLVED', entityId: res.body.id } });
      expect(log).toMatchObject({ actorId: ctx.ids.admin });
      expect(log.metadata).toMatchObject({
        previousClaimId: nameOnly.id, schoolId: annexe, source: 'STUDENT_REQUEST', placeDiffers: [], confirmedDifferentPlace: false, note: 'Same school, new record',
        claimed: { name: 'GS Ngoma Annexe', sector: 'Ngoma' }, actual: { sector: 'Ngoma' },
      });
      expect((await http().get(A).query({ hasSchool: false, limit: 100 }).set(bearer(admin)).expect(200)).body.data.map((c: any) => c.id)).not.toContain(res.body.id);
      // Verification is separate.
      await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: annexe }).expect(201);
      expect(await teacherSees()).not.toContain(s.id);
      await decide(res.body.id, 'verify');
      expect(await teacherSees()).toContain(s.id);
    });

    it('a different country is always refused; a different province / district / sector needs confirmDifferentPlace (audited with both places); no place entered → no confirmation', async () => {
      const ke = await mkStudent();
      await request(ke.token, { country: 'KE', schoolName: 'Nairobi School' }).expect(201);
      const keClaim = await claimOf(ke.id);
      expect(await status(http().post(`${A}/${keClaim.id}/match`).set(bearer(admin)).send({ schoolId: ngoma }))).toEqual([400, 'SCHOOL_COUNTRY_MISMATCH']);
      expect(await status(http().post(`${A}/${keClaim.id}/match`).set(bearer(admin)).send({ schoolId: ngoma, confirmDifferentPlace: true }))).toEqual([400, 'SCHOOL_COUNTRY_MISMATCH']);
      await http().post(`${A}/${keClaim.id}/match`).set(bearer(admin)).send({ schoolId: kenya }).expect(200);
      await consistent(ke.id);

      const rw = await mkStudent();
      await request(rw.token, { schoolName: 'GS Tumba Official Annexe', ...NGOMA }).expect(201);
      const rwClaim = await claimOf(rw.id);
      const refused = await http().post(`${A}/${rwClaim.id}/match`).set(bearer(admin)).send({ schoolId: tumba }).expect(400);
      expect(refused.body).toMatchObject({ code: 'SCHOOL_PLACE_MISMATCH', details: { differs: ['sector'], claimed: { sector: 'Ngoma' }, actual: { sector: 'Tumba' } } });
      expect(await claimOf(rw.id)).toMatchObject({ id: rwClaim.id });   // unchanged
      const ok = await http().post(`${A}/${rwClaim.id}/match`).set(bearer(admin)).send({ schoolId: tumba, confirmDifferentPlace: true }).expect(200);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_RESOLVED', entityId: ok.body.id } })).metadata)
        .toMatchObject({ placeDiffers: ['sector'], confirmedDifferentPlace: true, claimed: { sector: 'Ngoma' }, actual: { sector: 'Tumba' } });

      // Legacy registration claim without a place: nothing to compare.
      const legacy = await http().post('/api/v1/auth/register/student').send({
        firstName: 'L', lastName: 'Egacy', username: 'sc.legacy', email: 'sc.legacy@test.local', password: 'Secret123', gradeLevel: 'S2', homeLocation: 'Huye', schoolName: 'Some Old School',
      }).expect(201);
      const legacyId = (await p().user.findUniqueOrThrow({ where: { username: 'sc.legacy' } })).id;
      const legacyClaim = await claimOf(legacyId);
      expect(legacy.body.schoolVerification).toBe('PENDING');
      const m = await http().post(`${A}/${legacyClaim.id}/match`).set(bearer(admin)).send({ schoolId: kacyiru }).expect(200);
      expect(m.body).toMatchObject({ source: 'REGISTRATION', status: 'PENDING', school: { id: kacyiru } });
      for (const x of [rw.id, legacyId]) await consistent(x);
    });

    it('refused: already linked, superseded, not PENDING, inactive school, unknown school — nothing changes', async () => {
      const linked = await mkStudent(ngoma);
      expect(await status(http().post(`${A}/${(await claimOf(linked.id)).id}/match`).set(bearer(admin)).send({ schoolId: tumba }))).toEqual([409, 'AFFILIATION_ALREADY_RESOLVED']);

      const s = await mkStudent();
      await request(s.token, { schoolName: 'Superseded School', ...NGOMA }).expect(201);
      const first = await claimOf(s.id);
      await request(s.token, { schoolName: 'Newer School', ...NGOMA }).expect(201);
      expect(await status(http().post(`${A}/${first.id}/match`).set(bearer(admin)).send({ schoolId: ngoma }))).toEqual([409, 'AFFILIATION_SUPERSEDED']);

      const newer = await claimOf(s.id);
      await decide(newer.id, 'reject', 'Unknown school');
      expect(await status(http().post(`${A}/${newer.id}/match`).set(bearer(admin)).send({ schoolId: ngoma }))).toEqual([409, 'AFFILIATION_STATUS_CONFLICT']);

      const t = await mkStudent();
      await request(t.token, { schoolName: 'Closed Target', ...NGOMA }).expect(201);
      const tc = await claimOf(t.id);
      const closed = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'Closed Target', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }).expect(201)).body.id;
      await http().patch(`/api/v1/admin/schools/${closed}/active`).set(bearer(admin)).send({ isActive: false, reason: 'closed' }).expect(200);
      expect(await status(http().post(`${A}/${tc.id}/match`).set(bearer(admin)).send({ schoolId: closed }))).toEqual([409, 'SCHOOL_INACTIVE']);
      expect(await status(http().post(`${A}/${tc.id}/match`).set(bearer(admin)).send({ schoolId: '00000000-0000-4000-8000-000000000000' }))).toEqual([404, expect.any(String)]);
      expect(await claimOf(t.id)).toMatchObject({ id: tc.id, schoolId: null, status: 'PENDING' });
      expect((await p().user.findUniqueOrThrow({ where: { id: t.id } })).schoolId).toBeNull();
    });
  });

  // ─── Administrator reopening ───────────────────────────────────────────────

  describe('reopen', () => {
    it('the current REJECTED or REVOKED claim → a new PENDING claim for the same school (cooldown does not apply), audited with the previous status', async () => {
      const s = await mkStudent();
      await request(s.token, { schoolCode: '220001' }).expect(201);
      const rejected = await claimOf(s.id);
      await decide(rejected.id, 'reject', 'Needs a document');
      expect(await status(request(s.token, { schoolCode: '220001' }))).toEqual([429, 'CLAIM_COOLDOWN']);   // the student waits …
      const res = await http().post(`${A}/${rejected.id}/reopen`).set(bearer(admin)).send({ reason: 'Document received' }).expect(200);   // … an Administrator need not
      expect(res.body).toMatchObject({ status: 'PENDING', school: { id: ngoma }, source: 'STUDENT_REQUEST' });
      expect(await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: rejected.id } })).toMatchObject({ status: 'REJECTED', supersedeReason: 'REOPENED' });
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_REOPENED', entityId: res.body.id } })).metadata)
        .toMatchObject({ previousClaimId: rejected.id, previousStatus: 'REJECTED', schoolId: ngoma, reason: 'Document received' });

      await decide(res.body.id, 'verify');
      await decide(res.body.id, 'revoke', 'Left');
      const again = await http().post(`${A}/${res.body.id}/reopen`).set(bearer(admin)).send({ reason: 'Came back' }).expect(200);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_REOPENED', entityId: again.body.id } })).metadata).toMatchObject({ previousStatus: 'REVOKED' });
      await consistent(s.id);
    });

    it('a name-only claim reopens with its entered details; refused: PENDING / VERIFIED / superseded claims, an inactive school; a reason is required', async () => {
      const n = await mkStudent();
      await request(n.token, { schoolName: 'Reopen Me School', ...NGOMA }).expect(201);
      const c = await claimOf(n.id);
      expect(await status(http().post(`${A}/${c.id}/reopen`).set(bearer(admin)).send({ reason: 'not yet' }))).toEqual([409, 'AFFILIATION_STATUS_CONFLICT']);
      await decide(c.id, 'reject', 'Unknown');
      expect(await status(http().post(`${A}/${c.id}/reopen`).set(bearer(admin)).send({}))).toEqual([400, 'VALIDATION_FAILED']);
      const r = await http().post(`${A}/${c.id}/reopen`).set(bearer(admin)).send({ reason: 'Recheck' }).expect(200);
      expect(r.body).toMatchObject({ status: 'PENDING', school: null, claimedName: 'Reopen Me School', claimedSector: 'Ngoma' });
      expect(await status(http().post(`${A}/${c.id}/reopen`).set(bearer(admin)).send({ reason: 'twice' }))).toEqual([409, 'AFFILIATION_SUPERSEDED']);

      const s = await mkStudent();
      const closed = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'Reopen Closed School', code: '220888', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }).expect(201)).body.id;
      await request(s.token, { schoolCode: '220888' }).expect(201);
      const sc = await claimOf(s.id);
      await decide(sc.id, 'reject', 'Not on the register');
      await http().patch(`/api/v1/admin/schools/${closed}/active`).set(bearer(admin)).send({ isActive: false, reason: 'closed' }).expect(200);
      expect(await status(http().post(`${A}/${sc.id}/reopen`).set(bearer(admin)).send({ reason: 'Recheck' }))).toEqual([409, 'SCHOOL_INACTIVE']);
      expect(await claimOf(s.id)).toMatchObject({ id: sc.id, status: 'REJECTED' });
      for (const x of [n, s]) await consistent(x.id);
    });
  });

  // ─── Registration ──────────────────────────────────────────────────────────

  it('registration "not listed": the place is validated and kept on the PENDING claim; an exact unique match in that sector is linked; partial / invalid / foreign places refused; legacy name-only unchanged', async () => {
    const reg = (username: string, extra: object) => http().post('/api/v1/auth/register/student').send({
      firstName: 'R', lastName: username, username, email: `${username}@test.local`, password: 'Secret123', gradeLevel: 'S2', homeLocation: 'Huye', ...extra,
    });
    const user = (username: string) => p().user.findUniqueOrThrow({ where: { username } });
    await reg('sc.reg.nl', { schoolName: 'Unlisted Academy', ...NGOMA }).expect(201);
    const nl = await user('sc.reg.nl');
    expect(await claimOf(nl.id)).toMatchObject({ schoolId: null, claimedName: 'Unlisted Academy', claimedProvince: 'Southern Province', claimedDistrict: 'Huye', claimedSector: 'Ngoma', status: 'PENDING', source: 'REGISTRATION' });
    await reg('sc.reg.match', { schoolName: 'gs ngoma official', ...NGOMA }).expect(201);
    expect(await claimOf((await user('sc.reg.match')).id)).toMatchObject({ schoolId: ngoma, claimedSector: 'Ngoma', status: 'PENDING' });
    expect(await status(reg('sc.reg.partial', { schoolName: 'X Academy', schoolProvince: 'Southern Province' }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(reg('sc.reg.bad', { schoolName: 'X Academy', schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolSector: 'Nowhere' }))).toEqual([400, 'UNKNOWN_SCHOOL_LOCATION']);
    expect(await status(reg('sc.reg.ke', { country: 'KE', schoolName: 'X Academy', ...NGOMA }))).toEqual([400, 'SCHOOL_DIRECTORY_RWANDA_ONLY']);
    expect(await p().user.count({ where: { username: { in: ['sc.reg.partial', 'sc.reg.bad', 'sc.reg.ke'] } } })).toBe(0);
    await reg('sc.reg.legacy', { schoolName: 'gs kacyiru official' }).expect(201);   // legacy: unique official name anywhere
    expect(await claimOf((await user('sc.reg.legacy')).id)).toMatchObject({ schoolId: kacyiru, claimedName: null, status: 'PENDING' });
    for (const u of ['sc.reg.nl', 'sc.reg.match', 'sc.reg.legacy']) await consistent((await user(u)).id);
  });

  // ─── Atomicity ─────────────────────────────────────────────────────────────

  it('a failing audit write rolls back a student request, a match and a reopen: claim, User.schoolId and enrolment unchanged', async () => {
    const audit = ctx.app.get(AuditService);
    const failOn = (action: string) => {
      const original = audit.log.bind(audit);
      return vi.spyOn(audit, 'log').mockImplementation(async (entry: any, tx?: any) => {
        if (entry.action === action) throw new Error('audit unavailable');
        return original(entry, tx);
      });
    };
    const snapshot = async (id: string) => ({
      claims: await p().studentSchoolAffiliation.findMany({ where: { studentId: id }, orderBy: { createdAt: 'asc' } }),
      user: (await p().user.findUniqueOrThrow({ where: { id } })).schoolId,
      enrolment: (await p().studentEnrollment.findFirstOrThrow({ where: { studentId: id, academicYearId: ctx.ids.year } })).schoolId,
    });

    const s = await mkStudent(kacyiru);
    let before = await snapshot(s.id);
    let spy = failOn('SCHOOL_AFFILIATION_CREATED');
    try { expect((await request(s.token, { schoolCode: '220001' })).status).toBe(500); } finally { spy.mockRestore(); }
    expect(await snapshot(s.id)).toEqual(before);

    const n = await mkStudent();
    await request(n.token, { schoolName: 'Atomic School', ...NGOMA }).expect(201);
    const nc = await claimOf(n.id);
    before = await snapshot(n.id);
    spy = failOn('SCHOOL_AFFILIATION_RESOLVED');
    try { expect((await http().post(`${A}/${nc.id}/match`).set(bearer(admin)).send({ schoolId: ngoma, confirmDifferentPlace: true })).status).toBe(500); } finally { spy.mockRestore(); }
    expect(await snapshot(n.id)).toEqual(before);

    await decide(nc.id, 'reject', 'Not on the register');
    before = await snapshot(n.id);
    spy = failOn('SCHOOL_AFFILIATION_REOPENED');
    try { expect((await http().post(`${A}/${nc.id}/reopen`).set(bearer(admin)).send({ reason: 'Recheck' })).status).toBe(500); } finally { spy.mockRestore(); }
    expect(await snapshot(n.id)).toEqual(before);
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

    it('5 simultaneous student requests: exactly 3 succeed (the rest 429), one current claim, consistent', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const s = await mkStudent();
      const bodies = [{ schoolCode: '220001' }, { schoolCode: '220002' }, { schoolCode: '110001' }, { country: 'KE', schoolName: 'Race One' }, { country: 'UG', schoolName: 'Race Two' }];
      const results = await Promise.all(bodies.map((b) => request(s.token, b).then((r) => [r.status, r.body?.code ?? null])));
      expect(results.filter(([st]) => st === 201)).toHaveLength(3);
      expect(results.filter(([st]) => st !== 201)).toEqual([[429, 'CLAIM_LIMIT_REACHED'], [429, 'CLAIM_LIMIT_REACHED']]);
      expect(await p().studentSchoolAffiliation.count({ where: { studentId: s.id, source: 'STUDENT_REQUEST' } })).toBe(3);
      expect(await current(s.id)).toHaveLength(1);
      await consistent(s.id);
    });

    it('a match racing the student\'s own new request: one wins, the other is refused, and the student stays consistent', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const s = await mkStudent();
      await request(s.token, { schoolName: 'Race School', ...NGOMA }).expect(201);
      const c = await claimOf(s.id);
      const [m, r] = await Promise.all([
        http().post(`${A}/${c.id}/match`).set(bearer(admin)).send({ schoolId: ngoma, confirmDifferentPlace: true }).then((x) => [x.status, x.body?.code ?? null]),
        request(s.token, { schoolCode: '110001' }).then((x) => [x.status, x.body?.code ?? null]),
      ]);
      expect(r[0]).toBe(201);   // the student's request never depends on the claim's state
      expect([[200, null], [409, 'AFFILIATION_SUPERSEDED']]).toContainEqual(m);
      expect(await current(s.id)).toHaveLength(1);
      expect(await claimOf(s.id)).toMatchObject({ schoolId: kacyiru });   // the request is the latest either way
      await consistent(s.id);
    });

    it('a match started during a school deactivation waits for it, then is refused (409 SCHOOL_INACTIVE); nothing changes', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const school = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'Race Close School', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }).expect(201)).body.id;
      const s = await mkStudent();
      await request(s.token, { schoolName: 'Race Close School', ...NGOMA }).expect(201);
      const c = await claimOf(s.id);
      const holder = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await holder.connect();
      let result: unknown;
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE "School" SET "isActive" = false WHERE "id" = $1`, [school]);
        const match = http().post(`${A}/${c.id}/match`).set(bearer(admin)).send({ schoolId: school }).then((x) => [x.status, x.body?.code ?? null]);
        await wait(500);
        await holder.query('COMMIT');
        result = await match;
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
      // The pre-check may read the committed state (refused immediately) or the claim lock may wait for it — refused either way.
      expect(result).toEqual([409, 'SCHOOL_INACTIVE']);
      expect(await claimOf(s.id)).toMatchObject({ id: c.id, schoolId: null });
      await consistent(s.id);
    });

    it('two simultaneous reopens of one claim: exactly one succeeds, one REOPENED audit, one current claim', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const s = await mkStudent();
      await request(s.token, { schoolCode: '220002' }).expect(201);
      const c = await claimOf(s.id);
      await decide(c.id, 'reject', 'Not on the register');
      const results = await Promise.all([1, 2].map(() => http().post(`${A}/${c.id}/reopen`).set(bearer(admin)).send({ reason: 'Recheck' }).then((x) => [x.status, x.body?.code ?? null])));
      expect(results).toEqual(expect.arrayContaining([[200, null], [409, 'AFFILIATION_SUPERSEDED']]));
      expect(await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_REOPENED', metadata: { path: ['previousClaimId'], equals: c.id } } })).toBe(1);
      expect(await current(s.id)).toHaveLength(1);
      await consistent(s.id);
    });
  });

  // ─── Rollover (last: it changes the current year) ───────────────────────────

  it('after a match, an academic-year rollover keeps the claim and is not refused (enrolment followed the school)', async () => {
    const s = await mkStudent();
    await request(s.token, { schoolName: 'Rollover School', ...NGOMA }).expect(201);
    const school = (await http().post('/api/v1/admin/schools').set(bearer(admin)).send({ name: 'Rollover School', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' }).expect(201)).body.id;
    const matched = (await http().post(`${A}/${(await claimOf(s.id)).id}/match`).set(bearer(admin)).send({ schoolId: school }).expect(200)).body;
    const next = await http().post('/api/v1/admin/academic-years').set(bearer(admin)).send({ name: '2033-2034', startsOn: '2033-09-01', endsOn: '2034-07-31' }).expect(201);
    await http().post(`/api/v1/admin/academic-years/${next.body.id}/activate`).set(bearer(admin)).send({ promoteStudents: true }).expect(200);
    expect(await claimOf(s.id)).toMatchObject({ id: matched.id, schoolId: school, status: 'PENDING' });
    expect((await p().user.findUniqueOrThrow({ where: { id: s.id } })).schoolId).toBe(school);
  });
});
