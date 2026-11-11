/**
 * School administration PR A — Administrator-controlled student–school verification.
 *
 * Choosing a school, account approval and e-mail verification are not proof of
 * membership: only an Administrator (schools.manage) verifies, rejects or revokes a
 * claim, and a Teacher sees a student only with a CURRENT VERIFIED claim for the
 * Teacher's school. Every claim change and decision is atomic with its audit row.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

import { AuditService } from '../src/audit/audit.service.js';
import { SchoolAffiliationService } from '../src/schools/affiliations/school-affiliation.service.js';
import { createTestApp, login, bearer, inDays, PDF, PASSWORD, type TestContext } from './helpers.js';

const ROOT = join(__dirname, '..');
const M9_SQL = readFileSync(join(ROOT, 'prisma/migrations/20261121000800_student_school_affiliation/migration.sql'), 'utf8');
const M9_BACKFILL = M9_SQL.slice(M9_SQL.indexOf('-- BACKFILL BEGIN'), M9_SQL.indexOf('-- BACKFILL END'));
const M9_ROLLBACK = readFileSync(join(ROOT, 'docs/migrations/20261121000800_student_school_affiliation.rollback.sql'), 'utf8');
class Rollback extends Error {}

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

describe('Student–school affiliation (school administration PR A)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, coachJ: string, teacher: string, headCoach: string;
  let schoolA: string, schoolB: string, teacherId: string, workId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const A = '/api/v1/admin/school-affiliations';
  const current = (studentId: string) => p().studentSchoolAffiliation.findMany({ where: { studentId, supersededAt: null } });
  let seq = 0;
  /** A student (approved, activated) at a school, with a PENDING claim created through the service. */
  const student = async (schoolId: string | null, extra: object = {}) => {
    const n = ++seq;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const u = await p().user.create({ data: {
      username: `aff.s${n}`, firstName: 'Aff', lastName: `S${n}`, email: `aff.s${n}@test.local`, role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId, ...extra,
    } });
    if (schoolId) {
      await p().$transaction((tx) => ctx.app.get(SchoolAffiliationService).claim(tx, {
        studentId: u.id, schoolId, source: 'ADMIN', reason: 'NEW_CLAIM', actor: { actorId: ctx.ids.admin, actorRole: 'ADMIN' },
      }));
    }
    return u.id;
  };
  const claimOf = async (studentId: string) => (await current(studentId))[0];
  const verify = async (studentId: string) => http().post(`${A}/${(await claimOf(studentId)).id}/verify`).set(bearer(admin)).send({}).expect(200);

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coachJ = await login(ctx, 'mentor.j');
    schoolA = (await p().school.findUniqueOrThrow({ where: { name: 'Test School' } })).id;
    schoolB = (await p().school.create({ data: { name: 'AFF OTHER SCHOOL', location: 'Huye', code: '220999', province: 'Southern Province', district: 'Huye', sector: 'Ngoma', ownership: 'PUBLIC', nameKey: 'aff other school' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'HEAD_COACH' | 'SUPER_ADMIN') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
    teacherId = await mk('aff.teacher', 'TEACHER');
    await mk('aff.head', 'HEAD_COACH');
    await mk('aff.super', 'SUPER_ADMIN');
    [teacher, headCoach, superAdmin] = await Promise.all(['aff.teacher', 'aff.head', 'aff.super'].map((u) => login(ctx, u)));
    await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: schoolA }).expect(201);
    workId = (await p().assignment.create({ data: {
      title: 'Aff work', instructions: 'Solve.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(), allowResubmission: true, maxResubmissions: 3,
    } })).id;
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  // ─── Migration ─────────────────────────────────────────────────────────────

  describe('M9 backfill and rollback (the real SQL)', () => {
    async function inRolledBackTx(fn: (tx: any) => Promise<void>) {
      await expect(p().$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 60_000 })).rejects.toBeInstanceOf(Rollback);
    }

    it('every student with a school → one PENDING claim; name-only registrations → a claim without a school; nobody VERIFIED; idempotent; nothing else changed', async () => {
      await inRolledBackTx(async (tx) => {
        await tx.studentSchoolAffiliation.deleteMany({});
        const intl = await tx.user.create({ data: { username: 'm9.intl', firstName: 'I', lastName: 'N', email: 'm9.intl@test.local', role: 'STUDENT', gradeLevel: 'S2', divisionId: ctx.ids.junior } });
        await tx.auditLog.create({ data: { action: 'REGISTER', entity: 'User', entityId: intl.id, actorId: intl.id, actorRole: 'STUDENT', metadata: { country: 'KE', schoolNameEntered: 'Nairobi School', schoolLinked: false } } });
        const none = await tx.user.create({ data: { username: 'm9.none', firstName: 'N', lastName: 'O', email: 'm9.none@test.local', role: 'STUDENT', gradeLevel: 'S2', divisionId: ctx.ids.junior } });
        const before = {
          users: await tx.user.count(), schools: await tx.school.count(), enrolments: await tx.studentEnrollment.count(), submissions: await tx.submission.count(),
          links: (await tx.user.findMany({ select: { id: true, schoolId: true }, orderBy: { id: 'asc' } })),
        };
        const withSchool = await tx.user.count({ where: { role: 'STUDENT', schoolId: { not: null } } });

        await tx.$executeRawUnsafe(M9_BACKFILL);

        expect(await tx.studentSchoolAffiliation.count({ where: { schoolId: { not: null } } })).toBe(withSchool);
        expect(await tx.studentSchoolAffiliation.count({ where: { status: { not: 'PENDING' } } })).toBe(0);
        expect(await tx.studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: intl.id } }))
          .toMatchObject({ schoolId: null, claimedName: 'Nairobi School', claimedCountry: 'KE', status: 'PENDING', source: 'MIGRATION' });
        expect(await tx.studentSchoolAffiliation.count({ where: { studentId: none.id } })).toBe(0);
        const summary = await tx.auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_BACKFILL' } });
        expect(summary.metadata).toEqual({ withSchool, nameOnly: 1 });

        const total = await tx.studentSchoolAffiliation.count();
        await tx.$executeRawUnsafe(M9_BACKFILL);   // idempotent
        expect(await tx.studentSchoolAffiliation.count()).toBe(total);
        expect(await tx.auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_BACKFILL' } })).toBe(1);
        expect({
          users: await tx.user.count(), schools: await tx.school.count(), enrolments: await tx.studentEnrollment.count(), submissions: await tx.submission.count(),
          links: (await tx.user.findMany({ select: { id: true, schoolId: true }, orderBy: { id: 'asc' } })),
        }).toEqual(before);
      });
    });

    it('rollback drops only the table and its enums, and leaves Prisma\'s migration history alone', async () => {
      const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      try {
        await c.query('BEGIN');
        const statements = M9_ROLLBACK.split(/;\s*\n/).map((x) => x.replace(/--.*$/gm, '').trim()).filter((x) => x && !/^(BEGIN|COMMIT)$/i.test(x));
        expect(statements).toHaveLength(3);
        for (const s of statements) await c.query(s);
        expect((await c.query(`SELECT to_regclass('"StudentSchoolAffiliation"') AS t`)).rows[0].t).toBeNull();
        expect((await c.query(`SELECT count(*)::int AS n FROM pg_type WHERE typname IN ('SchoolAffiliationStatus', 'SchoolAffiliationSource')`)).rows[0].n).toBe(0);
        expect((await c.query(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '20261121000800_student_school_affiliation'`)).rows[0].n).toBe(1);
        expect((await c.query(`SELECT count(*)::int AS n FROM "School"`)).rows[0].n).toBeGreaterThan(0);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      expect(await p().studentSchoolAffiliation.count()).toBeGreaterThanOrEqual(0);   // the table still exists (nothing persisted)
    });
  });

  // ─── Claims ────────────────────────────────────────────────────────────────

  describe('claims are created PENDING on every path that sets a school', () => {
    it('self-registration: by code → a claim for that school; another country → a claim without a school; response schoolVerification', async () => {
      const reg = (username: string, extra: object) => http().post('/api/v1/auth/register/student').send({
        firstName: 'R', lastName: username, username, email: `${username}@test.local`, password: 'Secret123', gradeLevel: 'S2', homeLocation: 'Kigali', ...extra,
      });
      const byCode = await reg('aff.reg.code', { schoolCode: '220999' }).expect(201);
      expect(byCode.body.schoolVerification).toBe('PENDING');
      const u1 = await p().user.findUniqueOrThrow({ where: { username: 'aff.reg.code' } });
      expect(await current(u1.id)).toEqual([expect.objectContaining({ schoolId: schoolB, status: 'PENDING', source: 'REGISTRATION', createdById: u1.id })]);
      const intl = await reg('aff.reg.ke', { country: 'KE', schoolName: 'Nairobi School' }).expect(201);
      expect(intl.body.schoolVerification).toBe('PENDING');
      const u2 = await p().user.findUniqueOrThrow({ where: { username: 'aff.reg.ke' } });
      expect(await current(u2.id)).toEqual([expect.objectContaining({ schoolId: null, claimedName: 'Nairobi School', claimedCountry: 'KE', status: 'PENDING' })]);
      expect(await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_CREATED', actorId: u1.id } })).toBe(1);
    });

    it('Administrator create and invite (with a school) → PENDING, never verified automatically; CSV import too', async () => {
      const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
        firstName: 'C', lastName: 'Admin', username: 'aff.created', email: 'aff.created@test.local', password: 'Str0ng!Passw0rd', role: 'STUDENT', gradeLevel: 'S2', schoolId: schoolA,
      }).expect(201);
      expect(await current(created.body.id)).toEqual([expect.objectContaining({ schoolId: schoolA, status: 'PENDING', source: 'ADMIN', createdById: ctx.ids.admin })]);
      const invited = await http().post('/api/v1/admin/users/invite').set(bearer(admin)).send({
        firstName: 'I', lastName: 'Inv', email: 'aff.invited@test.local', username: 'aff.invited', gradeLevel: 'S2', schoolId: schoolB,
      }).expect(201);
      expect(await current(invited.body.user.id)).toEqual([expect.objectContaining({ schoolId: schoolB, status: 'PENDING', source: 'ADMIN' })]);
      const csv = ['firstName,lastName,email,username,role,gradeLevel,schoolId', `Csv,Row,aff.csv@test.local,aff.csv,STUDENT,S2,${schoolA}`].join('\r\n');
      await http().post('/api/v1/admin/users/import').query({ dryRun: false }).set(bearer(admin))
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 's.csv', contentType: 'text/csv' }).expect(200);
      const csvUser = await p().user.findUniqueOrThrow({ where: { username: 'aff.csv' } });
      expect(await current(csvUser.id)).toEqual([expect.objectContaining({ schoolId: schoolA, status: 'PENDING', source: 'ADMIN' })]);
    });

    it('a school change supersedes the claim (SCHOOL_CHANGE) — a verified one too; role changes supersede (ROLE_CHANGE) and re-claim; always exactly one current claim', async () => {
      const s = await student(schoolA);
      await verify(s);
      const verifiedId = (await claimOf(s)).id;
      await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: schoolB }).expect(200);
      const old = await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: verifiedId } });
      expect(old).toMatchObject({ status: 'VERIFIED', supersedeReason: 'SCHOOL_CHANGE', supersededById: ctx.ids.admin });
      expect(old.supersededAt).not.toBeNull();
      expect(await current(s)).toEqual([expect.objectContaining({ schoolId: schoolB, status: 'PENDING', source: 'ADMIN' })]);
      // The same school again: no new claim.
      await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: schoolB }).expect(200);
      expect(await p().studentSchoolAffiliation.count({ where: { studentId: s } })).toBe(2);
      // STUDENT → COACH: the claim ends, none current.
      await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
      expect(await current(s)).toEqual([]);
      expect((await p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: s, schoolId: schoolB } })).supersedeReason).toBe('ROLE_CHANGE');
      // COACH → STUDENT with a school: a new PENDING claim (no old verification comes back).
      await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ role: 'STUDENT', gradeLevel: 'S2', schoolId: schoolA }).expect(200);
      expect(await current(s)).toEqual([expect.objectContaining({ schoolId: schoolA, status: 'PENDING' })]);
      expect(await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', metadata: { path: ['studentId'], equals: s } } })).toBe(2);
      // Invariant: the current claim's school is the student's school.
      expect((await p().user.findUniqueOrThrow({ where: { id: s } })).schoolId).toBe((await claimOf(s)).schoolId);
    });
  });

  // ─── Decisions ─────────────────────────────────────────────────────────────

  describe('Administrator decisions', () => {
    it('verify / reject / revoke: recorded with who, when and why; wrong transitions 409; reasons required; name-only claims cannot be verified', async () => {
      const s = await student(schoolA);
      const id = (await claimOf(s)).id;
      expect((await http().post(`${A}/${id}/reject`).set(bearer(admin)).send({})).status).toBe(400);   // reason required
      expect(await status(http().post(`${A}/${id}/revoke`).set(bearer(admin)).send({ reason: 'not yet verified' }))).toEqual([409, 'AFFILIATION_STATUS_CONFLICT']);
      const v = await http().post(`${A}/${id}/verify`).set(bearer(admin)).send({ note: 'Checked with the school register' }).expect(200);
      expect(v.body).toMatchObject({ status: 'VERIFIED', decidedBy: { id: ctx.ids.admin }, decisionReason: 'Checked with the school register' });
      expect(v.body.decidedAt).toBeTruthy();
      expect(await status(http().post(`${A}/${id}/verify`).set(bearer(admin)).send({}))).toEqual([409, 'AFFILIATION_STATUS_CONFLICT']);
      const r = await http().post(`${A}/${id}/revoke`).set(bearer(superAdmin)).send({ reason: 'Left the school' }).expect(200);
      expect(r.body).toMatchObject({ status: 'REVOKED', revokeReason: 'Left the school' });
      for (const action of ['SCHOOL_AFFILIATION_VERIFIED', 'SCHOOL_AFFILIATION_REVOKED']) {
        expect([action, await p().auditLog.count({ where: { action, entityId: id } })]).toEqual([action, 1]);
      }
      const s2 = await student(schoolA);
      const rej = await http().post(`${A}/${(await claimOf(s2)).id}/reject`).set(bearer(admin)).send({ reason: 'Not on the school register' }).expect(200);
      expect(rej.body).toMatchObject({ status: 'REJECTED', decisionReason: 'Not on the school register' });

      const intl = await student(null);
      const noSchool = await p().$transaction((tx) => ctx.app.get(SchoolAffiliationService).claim(tx, {
        studentId: intl, schoolId: null, claimed: { name: 'Nairobi School', country: 'KE' }, source: 'REGISTRATION', reason: 'NEW_CLAIM', actor: { actorId: intl, actorRole: 'STUDENT' },
      }));
      expect(await status(http().post(`${A}/${noSchool}/verify`).set(bearer(admin)).send({}))).toEqual([409, 'AFFILIATION_SCHOOL_REQUIRED']);
      expect((await http().post(`${A}/00000000-0000-4000-8000-000000000000/verify`).set(bearer(admin)).send({})).status).toBe(404);
    });

    it('a decision on a superseded claim is refused (409), and changes nothing', async () => {
      const s = await student(schoolA);
      const oldId = (await claimOf(s)).id;
      await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: schoolB }).expect(200);
      expect(await status(http().post(`${A}/${oldId}/verify`).set(bearer(admin)).send({}))).toEqual([409, 'AFFILIATION_SUPERSEDED']);
      expect((await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: oldId } })).status).toBe('PENDING');
    });

    it('a failing audit write rolls back the decision, and the claim of an Administrator-created student with the account', async () => {
      const audit = ctx.app.get(AuditService);
      const s = await student(schoolA);
      const id = (await claimOf(s)).id;
      let spy = vi.spyOn(audit, 'log').mockImplementationOnce(async () => { throw new Error('audit unavailable'); });
      try { expect((await http().post(`${A}/${id}/verify`).set(bearer(admin)).send({})).status).toBe(500); } finally { spy.mockRestore(); }
      expect((await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING');
      expect(await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_VERIFIED', entityId: id } })).toBe(0);

      // The claim's own audit row fails → the whole account creation rolls back.
      const original = audit.log.bind(audit);
      spy = vi.spyOn(audit, 'log').mockImplementation(async (entry: any, tx?: any) => {
        if (entry.action === 'SCHOOL_AFFILIATION_CREATED') throw new Error('audit unavailable');
        return original(entry, tx);
      });
      try {
        expect((await http().post('/api/v1/admin/users').set(bearer(admin)).send({
          firstName: 'R', lastName: 'B', username: 'aff.rollback', email: 'aff.rollback@test.local', password: 'Str0ng!Passw0rd', role: 'STUDENT', gradeLevel: 'S2', schoolId: schoolA,
        })).status).toBe(500);
      } finally { spy.mockRestore(); }
      expect(await p().user.count({ where: { username: 'aff.rollback' } })).toBe(0);
    });

    it('authorization: only Administrators and Super Admins use the affiliation routes; everyone else 403, anonymous 401', async () => {
      const s = await student(schoolA);
      const id = (await claimOf(s)).id;
      const studentToken = await login(ctx, 'student.j');
      const routes = [
        () => http().get(A), () => http().get(`${A}/${id}`), () => http().get(`/api/v1/admin/users/${s}/school-affiliations`),
        () => http().post(`${A}/${id}/verify`).send({}), () => http().post(`${A}/${id}/reject`).send({ reason: 'xxx' }), () => http().post(`${A}/${id}/revoke`).send({ reason: 'xxx' }),
      ];
      for (const make of routes) {
        for (const token of [teacher, headCoach, coachJ, studentToken]) expect(await status(make().set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
        expect((await make()).status).toBe(401);
      }
      expect((await claimOf(s)).status).toBe('PENDING');
      await http().get(A).query({ status: 'PENDING', schoolId: schoolA }).set(bearer(superAdmin)).expect(200);
      const hist = await http().get(`/api/v1/admin/users/${s}/school-affiliations`).set(bearer(admin)).expect(200);
      expect(hist.body.map((h: any) => h.id)).toEqual([id]);
    });
  });

  // ─── The student's view ────────────────────────────────────────────────────

  it('a student sees their own status and the reason of a rejection or revocation — never who decided', async () => {
    const res0 = await http().post('/api/v1/auth/register/student').send({
      firstName: 'M', lastName: 'E', username: 'aff.me', email: 'aff.me@test.local', password: 'Secret123', gradeLevel: 'S2', homeLocation: 'Kigali', schoolCode: '220999',
    }).expect(201);
    const token = await login(ctx, 'aff.me', 'Secret123');
    expect((await http().get('/api/v1/me/school-affiliation').set(bearer(token)).expect(200)).body.current).toMatchObject({ status: 'PENDING', school: { code: '220999' }, reason: null });
    await http().post(`${A}/${(await claimOf(res0.body.id)).id}/reject`).set(bearer(admin)).send({ reason: 'Please upload a school ID card' }).expect(200);
    const after = (await http().get('/api/v1/me/school-affiliation').set(bearer(token)).expect(200)).body.current;
    expect(after).toMatchObject({ status: 'REJECTED', reason: 'Please upload a school ID card' });
    expect(JSON.stringify(after)).not.toMatch(/decidedBy|username|admin/i);
    for (const t of [teacher, coachJ, admin]) expect((await http().get('/api/v1/me/school-affiliation').set(bearer(t))).status).toBe(403);
  });

  // ─── Teacher isolation ─────────────────────────────────────────────────────

  it('Teacher views: only students with a CURRENT VERIFIED claim for the Teacher\'s school — every other status, and other schools, are 404 on all four routes', async () => {
    await p().userPermissionOverride.createMany({ data: ['students.viewProfile', 'students.viewProgress', 'submissions.submitOnBehalf'].map((permission) => ({
      userId: teacherId, permission, effect: 'GRANT' as const, reason: 'aff tests', createdById: ctx.ids.admin,
    })) });
    const verifiedA = await student(schoolA); await verify(verifiedA);
    const pendingA = await student(schoolA);
    const rejectedA = await student(schoolA);
    await http().post(`${A}/${(await claimOf(rejectedA)).id}/reject`).set(bearer(admin)).send({ reason: 'Not enrolled at this school' }).expect(200);
    const revokedA = await student(schoolA); await verify(revokedA);
    await http().post(`${A}/${(await claimOf(revokedA)).id}/revoke`).set(bearer(admin)).send({ reason: 'left' }).expect(200);
    const movedAway = await student(schoolA); await verify(movedAway);
    await http().patch(`/api/v1/admin/users/${movedAway}`).set(bearer(admin)).send({ schoolId: schoolB }).expect(200);
    const verifiedB = await student(schoolB); await verify(verifiedB);

    const listed = (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data.map((s: any) => s.id);
    expect(listed).toContain(verifiedA);
    for (const hidden of [pendingA, rejectedA, revokedA, movedAway, verifiedB]) {
      expect([hidden, listed.includes(hidden)]).toEqual([hidden, false]);
      expect([hidden, (await http().get(`/api/v1/teacher/students/${hidden}`).set(bearer(teacher))).status]).toEqual([hidden, 404]);
      expect([hidden, (await http().get(`/api/v1/teacher/students/${hidden}/progress`).set(bearer(teacher))).status]).toEqual([hidden, 404]);
      expect([hidden, (await http().post(`/api/v1/teacher/students/${hidden}/submissions`).set(bearer(teacher)).field('assignmentId', workId).attach('file', PDF, 'w.pdf')).status]).toEqual([hidden, 404]);
    }
    await http().get(`/api/v1/teacher/students/${verifiedA}`).set(bearer(teacher)).expect(200);
    await http().get(`/api/v1/teacher/students/${verifiedA}/progress`).set(bearer(teacher)).expect(200);
    // Revocation applies on the Teacher's next request.
    await http().post(`${A}/${(await claimOf(verifiedA)).id}/revoke`).set(bearer(admin)).send({ reason: 'checked again' }).expect(200);
    expect((await http().get(`/api/v1/teacher/students/${verifiedA}`).set(bearer(teacher))).status).toBe(404);
    expect(await p().submission.count({ where: { studentId: { in: [pendingA, rejectedA, revokedA, movedAway, verifiedB] } } })).toBe(0);
  });

  // ─── Leaderboard ───────────────────────────────────────────────────────────

  it('leaderboard: a school list and the school totals count verified students only; an unverified school is never shown next to a name', async () => {
    const verified = await student(schoolA, { points: 900 }); await verify(verified);
    const unverified = await student(schoolA, { points: 950 });
    const byId = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r]));
    const general = byId((await http().get('/api/v1/leaderboard').query({ divisionId: ctx.ids.junior, limit: 100 }).set(bearer(admin)).expect(200)).body.data);
    expect(general[verified].school).toMatchObject({ id: schoolA });
    expect(general[unverified].school).toBeNull();
    const ofSchool = (await http().get('/api/v1/leaderboard').query({ divisionId: ctx.ids.junior, schoolId: schoolA, limit: 100 }).set(bearer(admin)).expect(200)).body.data.map((r: any) => r.id);
    expect(ofSchool).toContain(verified);
    expect(ofSchool).not.toContain(unverified);
    const verifiedAtA = await p().user.count({ where: { role: 'STUDENT', isActive: true, divisionId: ctx.ids.junior, schoolId: schoolA,
      schoolAffiliations: { some: { supersededAt: null, status: 'VERIFIED', schoolId: schoolA } } } });
    const schools = (await http().get('/api/v1/leaderboard/schools').query({ divisionId: ctx.ids.junior }).set(bearer(admin)).expect(200)).body.data;
    expect(schools.find((s: any) => s.schoolId === schoolA)).toMatchObject({ studentCount: verifiedAtA });
    // Teachers and Head Coaches stay refused, as before.
    for (const t of [teacher, headCoach]) expect(await status(http().get('/api/v1/leaderboard').query({ divisionId: ctx.ids.junior }).set(bearer(t)))).toEqual([403, 'ROLE_NOT_SUPPORTED']);
  });

  // ─── Concurrency (PostgreSQL in CI) ────────────────────────────────────────

  it('concurrency: two decisions on one claim — exactly one wins and one audit row; two simultaneous claims — exactly one current', async (test) => {
    if (!(await servesConcurrentConnections())) {
      if (process.env.CI) throw new Error('CI database must serve concurrent connections for this test.');
      test.skip('local single-connection database (prisma dev): runs in CI on PostgreSQL');
    }
    const svc = ctx.app.get(SchoolAffiliationService);
    const adminUser = { id: ctx.ids.admin, role: 'ADMIN', username: 'admin' } as any;
    const s = await student(schoolA);
    const id = (await claimOf(s)).id;
    const results = await Promise.allSettled([svc.verify(id, adminUser), svc.reject(id, adminUser, 'race'), svc.verify(id, adminUser)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await p().auditLog.count({ where: { entityId: id, action: { in: ['SCHOOL_AFFILIATION_VERIFIED', 'SCHOOL_AFFILIATION_REJECTED'] } } })).toBe(1);

    const t = await student(schoolA);
    await Promise.allSettled(Array.from({ length: 5 }, (_, i) => p().$transaction((tx) => svc.claim(tx, {
      studentId: t, schoolId: i % 2 ? schoolA : schoolB, source: 'ADMIN', reason: 'SCHOOL_CHANGE', actor: { actorId: ctx.ids.admin, actorRole: 'ADMIN' },
    }))));
    expect(await current(t)).toHaveLength(1);
  });
});
