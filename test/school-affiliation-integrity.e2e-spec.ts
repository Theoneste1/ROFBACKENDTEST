/**
 * School administration PR A.1 — hardening after the PR #25 review.
 *
 *   M10: the database itself enforces one current claim per student and that the current
 *        claim's school is User.schoolId (triggers checked after every statement).
 *   The audit of a superseded claim records the status it had when it was replaced.
 *   Administrator edits decide the claim from the locked current state, so concurrent edits agree.
 *   Head Coach views label each school VERIFIED or UNVERIFIED.
 *   Registration and edits go through SchoolAffiliationService; re-sending the same school and an
 *   academic-year rollover keep the claim unchanged.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

import { RoleAssignmentPolicy } from '../src/auth/role-assignment.policy.js';
import { SchoolAffiliationService } from '../src/schools/affiliations/school-affiliation.service.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext, currentYearId } from './helpers.js';

const ROOT = join(__dirname, '..');
/** A migration or rollback file without its BEGIN/COMMIT, to run inside a test's own transaction. */
const body = (path: string) => readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n').split('\n')
  .filter((l) => !/^(BEGIN|COMMIT);$/.test(l.trim())).join('\n');
const M10 = body('prisma/migrations/20261121000900_school_affiliation_integrity/migration.sql');
const M10_ROLLBACK = body('docs/migrations/20261121000900_school_affiliation_integrity.rollback.sql');

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

describe('Student–school affiliation hardening (school administration PR A.1)', () => {
  let ctx: TestContext;
  let admin: string, headCoach: string, teacher: string;
  let schoolA: string, schoolB: string, maths: string, teacherId: string;
  /** Verified at A while this year's enrolment names B (set up by the Head Coach test, used by the rollover test). */
  let divergent: string | undefined;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const svc = () => ctx.app.get(SchoolAffiliationService);
  const A = '/api/v1/admin/school-affiliations';
  const ACTOR = () => ({ actorId: ctx.ids.admin, actorRole: 'ADMIN' });
  const current = (studentId: string) => p().studentSchoolAffiliation.findMany({ where: { studentId, supersededAt: null } });
  const claimOf = async (studentId: string) => (await current(studentId))[0];
  const verify = async (studentId: string) => http().post(`${A}/${(await claimOf(studentId)).id}/verify`).set(bearer(admin)).send({}).expect(200);
  /** Both invariants hold for the student. */
  const consistent = async (studentId: string) => {
    const claims = await current(studentId);
    const user = await p().user.findUniqueOrThrow({ where: { id: studentId } });
    expect(claims.length).toBeLessThanOrEqual(1);
    if (claims[0]) expect(claims[0].schoolId).toBe(user.schoolId);
  };
  let seq = 0;
  /** A student (approved, activated) at a school; with `claim`, a PENDING claim made through the service. */
  const student = async (schoolId: string | null, opts: { claim?: boolean; programme?: boolean } = {}) => {
    const n = ++seq;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const u = await p().user.create({ data: {
      username: `a1.s${n}`, firstName: 'A1', lastName: `S${n}`, email: `a1.s${n}@test.local`, role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId,
    } });
    if (schoolId && (opts.claim ?? true)) {
      await p().$transaction((tx) => svc().claim(tx, { studentId: u.id, schoolId, source: 'ADMIN', reason: 'NEW_CLAIM', actor: ACTOR() }));
    }
    if (opts.programme) await p().programmeMembership.create({ data: { userId: u.id, disciplineId: maths, source: 'MANUAL' } });
    return u.id;
  };
  const insertClaim = (studentId: string, schoolId: string | null, supersededAt: Date | null = null) =>
    p().$executeRaw`INSERT INTO "StudentSchoolAffiliation" ("id", "studentId", "schoolId", "status", "source", "supersededAt")
                    VALUES (gen_random_uuid()::text, ${studentId}, ${schoolId}, 'PENDING', 'ADMIN', ${supersededAt})`;

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    schoolA = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    schoolB = (await p().school.create({ data: { name: 'A1 OTHER SCHOOL', location: 'Huye', code: '220998', province: 'Southern Province', district: 'Huye', sector: 'Ngoma', ownership: 'PUBLIC', nameKey: 'a1 other school' } })).id;
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'TEACHER' | 'HEAD_COACH') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'T', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
    teacherId = await mk('a1.teacher', 'TEACHER');
    const headId = await mk('a1.head', 'HEAD_COACH');
    [teacher, headCoach] = await Promise.all(['a1.teacher', 'a1.head'].map((u) => login(ctx, u)));
    await http().post('/api/v1/admin/teacher-assignments').set(bearer(admin)).send({ teacherId, schoolId: schoolA }).expect(201);
    await http().put(`/api/v1/admin/programmes/${maths}/heads`).set(bearer(admin)).send({ userIds: [headId] }).expect(200);
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  // ─── M10: database enforcement ─────────────────────────────────────────────

  describe('M10: the database enforces the invariants, whatever the writer', () => {
    it('a second current claim is refused (direct SQL, the Prisma client, or re-opening a superseded claim); nothing is written', async () => {
      const s = await student(schoolA);
      const before = await p().studentSchoolAffiliation.count({ where: { studentId: s } });
      await expect(p().$transaction((tx) => tx.$executeRaw`INSERT INTO "StudentSchoolAffiliation" ("id", "studentId", "schoolId", "status", "source")
        VALUES (gen_random_uuid()::text, ${s}, ${schoolA}, 'PENDING', 'ADMIN')`)).rejects.toThrow(/AFFILIATION_ONE_CURRENT/);
      await expect(insertClaim(s, schoolA)).rejects.toThrow(/AFFILIATION_ONE_CURRENT/);   // outside an explicit transaction too
      await expect(p().studentSchoolAffiliation.create({ data: { studentId: s, schoolId: schoolA, source: 'ADMIN' } })).rejects.toThrow(/AFFILIATION_ONE_CURRENT/);
      // A superseded claim cannot be made current again next to the current one.
      await insertClaim(s, schoolB, new Date());
      const old = await p().studentSchoolAffiliation.findFirstOrThrow({ where: { studentId: s, supersededAt: { not: null } } });
      await expect(p().studentSchoolAffiliation.update({ where: { id: old.id }, data: { supersededAt: null } })).rejects.toThrow(/AFFILIATION_ONE_CURRENT|AFFILIATION_SCHOOL_MISMATCH/);
      expect(await p().studentSchoolAffiliation.count({ where: { studentId: s } })).toBe(before + 1);   // only the superseded row
      expect(await current(s)).toHaveLength(1);
    });

    it('the current claim must be for User.schoolId after every statement: changing only one is refused; ending the claim, changing the school, then claiming is accepted', async () => {
      const s = await student(schoolA);
      const claim = await claimOf(s);
      await expect(p().user.update({ where: { id: s }, data: { schoolId: schoolB } })).rejects.toThrow(/AFFILIATION_SCHOOL_MISMATCH/);
      await expect(p().studentSchoolAffiliation.update({ where: { id: claim.id }, data: { schoolId: schoolB } })).rejects.toThrow(/AFFILIATION_SCHOOL_MISMATCH/);
      await expect(p().$transaction((tx) => svc().claim(tx, { studentId: s, schoolId: schoolB, source: 'ADMIN', reason: 'SCHOOL_CHANGE', actor: ACTOR() })))
        .rejects.toThrow(/AFFILIATION_SCHOOL_MISMATCH/);
      expect(await current(s)).toEqual([expect.objectContaining({ id: claim.id, schoolId: schoolA })]);   // all three rolled back
      expect((await p().user.findUniqueOrThrow({ where: { id: s } })).schoolId).toBe(schoolA);

      // A mismatch in the middle of a transaction is refused at that statement, even if a later one would fix it.
      await expect(p().$transaction(async (tx) => {
        await tx.user.update({ where: { id: s }, data: { schoolId: schoolB } });
        await svc().claim(tx, { studentId: s, schoolId: schoolB, source: 'ADMIN', reason: 'SCHOOL_CHANGE', actor: ACTOR() });
      })).rejects.toThrow(/AFFILIATION_SCHOOL_MISMATCH/);
      expect(await current(s)).toEqual([expect.objectContaining({ id: claim.id, schoolId: schoolA })]);
      // The supported order: end the claim, change the school, claim — through the service, and in plain SQL.
      await p().$transaction(async (tx) => {
        await svc().supersede(tx, s, 'SCHOOL_CHANGE', ACTOR());
        await tx.user.update({ where: { id: s }, data: { schoolId: schoolB } });
        await svc().claim(tx, { studentId: s, schoolId: schoolB, source: 'ADMIN', reason: 'SCHOOL_CHANGE', actor: ACTOR() });
      });
      await p().$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE "StudentSchoolAffiliation" SET "supersededAt" = now(), "supersedeReason" = 'SCHOOL_CHANGE' WHERE "studentId" = ${s} AND "supersededAt" IS NULL`;
        await tx.$executeRaw`UPDATE "User" SET "schoolId" = ${schoolA} WHERE "id" = ${s}`;
        await tx.$executeRaw`INSERT INTO "StudentSchoolAffiliation" ("id", "studentId", "schoolId", "status", "source") VALUES (gen_random_uuid()::text, ${s}, ${schoolA}, 'PENDING', 'ADMIN')`;
      });
      expect(await current(s)).toEqual([expect.objectContaining({ schoolId: schoolA, status: 'PENDING' })]);
      await consistent(s);
    });

    it('still allowed: superseded claims at any school; students without a current claim; a name-only claim for a student without a school; deleting a student', async () => {
      const noClaim = await student(schoolA, { claim: false });
      await p().user.update({ where: { id: noClaim }, data: { schoolId: schoolB } });   // no current claim → nothing to match
      await insertClaim(noClaim, schoolA, new Date());                                  // superseded, another school

      const intl = await student(null);
      await p().$transaction((tx) => svc().claim(tx, { studentId: intl, schoolId: null, claimed: { name: 'Nairobi School', country: 'KE' }, source: 'ADMIN', reason: 'NEW_CLAIM', actor: ACTOR() }));
      await expect(p().user.update({ where: { id: intl }, data: { schoolId: schoolA } })).rejects.toThrow(/AFFILIATION_SCHOOL_MISMATCH/);

      const leaving = await student(schoolA);
      await verify(leaving);
      await p().user.delete({ where: { id: leaving } });
      expect(await p().studentSchoolAffiliation.count({ where: { studentId: leaving } })).toBe(0);
      for (const s of [noClaim, intl]) await consistent(s);
    });

    it('the pre-check refuses to apply M10 over violating data; the rollback removes only its triggers and function and leaves Prisma\'s history alone; re-applying works', async () => {
      const s = await student(schoolA);
      const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await c.connect();
      const count = async (sql: string) => (await c.query(sql)).rows[0].n;
      const TRIGGERS = `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('school_affiliation_integrity', 'user_school_affiliation_integrity')`;
      try {
        expect(await count(TRIGGERS)).toBe(2);

        // Rollback, then a violation (two current claims), then M10 again → refused by the pre-check.
        await c.query('BEGIN');
        await c.query(M10_ROLLBACK);
        expect(await count(TRIGGERS)).toBe(0);
        expect((await c.query(`SELECT to_regproc('school_affiliation_integrity') AS f`)).rows[0].f).toBeNull();
        expect(await count(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '20261121000900_school_affiliation_integrity'`)).toBe(1);
        await c.query(`INSERT INTO "StudentSchoolAffiliation" ("id", "studentId", "schoolId", "status", "source") VALUES (gen_random_uuid()::text, $1, $2, 'PENDING', 'ADMIN')`, [s, schoolA]);
        await expect(c.query(M10)).rejects.toThrow(/AFFILIATION_INTEGRITY: 1 student\(s\) with several current claims/);
        await c.query('ROLLBACK');

        // A mismatch is refused too.
        await c.query('BEGIN');
        await c.query(M10_ROLLBACK);
        await c.query(`UPDATE "User" SET "schoolId" = $1 WHERE "id" = $2`, [schoolB, s]);
        await expect(c.query(M10)).rejects.toThrow(/AFFILIATION_INTEGRITY: 0 student\(s\) with several current claims and 1 current claim/);
        await c.query('ROLLBACK');

        // Over consistent data: rollback then re-apply restores both triggers.
        await c.query('BEGIN');
        await c.query(M10_ROLLBACK);
        await c.query(M10);
        expect(await count(TRIGGERS)).toBe(2);
        await c.query('ROLLBACK');
        expect(await count(TRIGGERS)).toBe(2);   // nothing persisted
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      await consistent(s);
    });
  });

  // ─── Service paths ─────────────────────────────────────────────────────────

  it('registration calls claim(); an Administrator edit calls beginUserChange() then claim(); create and invite call claim()', async () => {
    const claim = vi.spyOn(svc(), 'claim');
    const sync = vi.spyOn(svc(), 'beginUserChange');
    try {
      await http().post('/api/v1/auth/register/student').send({
        firstName: 'R', lastName: 'Reg', username: 'a1.reg', email: 'a1.reg@test.local', password: 'Secret123', gradeLevel: 'S2', homeLocation: 'Kigali', schoolCode: '220998',
      }).expect(201);
      const reg = await p().user.findUniqueOrThrow({ where: { username: 'a1.reg' } });
      expect(claim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ studentId: reg.id, schoolId: schoolB, source: 'REGISTRATION' }));

      claim.mockClear();
      await http().patch(`/api/v1/admin/users/${reg.id}`).set(bearer(admin)).send({ schoolId: schoolA }).expect(200);
      expect(sync).toHaveBeenCalledWith(expect.anything(), { id: reg.id, isStudent: true, schoolId: schoolA, becameStudent: false }, { actorId: ctx.ids.admin, actorRole: 'ADMIN' });
      expect(claim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ studentId: reg.id, schoolId: schoolA, source: 'ADMIN', reason: 'SCHOOL_CHANGE' }));
      expect(await current(reg.id)).toEqual([expect.objectContaining({ schoolId: schoolA, status: 'PENDING', source: 'ADMIN' })]);

      // A name-only edit leaves the claim alone and does not call the service.
      sync.mockClear();
      await http().patch(`/api/v1/admin/users/${reg.id}`).set(bearer(admin)).send({ firstName: 'Renamed' }).expect(200);
      expect(sync).not.toHaveBeenCalled();

      claim.mockClear();
      const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
        firstName: 'C', lastName: 'Admin', username: 'a1.created', email: 'a1.created@test.local', password: 'Str0ng!Passw0rd', role: 'STUDENT', gradeLevel: 'S2', schoolId: schoolA,
      }).expect(201);
      const invited = await http().post('/api/v1/admin/users/invite').set(bearer(admin)).send({
        firstName: 'I', lastName: 'Inv', email: 'a1.invited@test.local', username: 'a1.invited', gradeLevel: 'S2', schoolId: schoolB,
      }).expect(201);
      expect(claim.mock.calls.map(([, input]) => [input.studentId, input.schoolId])).toEqual([[created.body.id, schoolA], [invited.body.user.id, schoolB]]);
      for (const s of [reg.id, created.body.id, invited.body.user.id]) await consistent(s);
    } finally {
      claim.mockRestore();
      sync.mockRestore();
    }
  });

  it('re-sending the same school keeps the claim: the same row, still VERIFIED, no new claim and no supersede audit', async () => {
    const s = await student(schoolA);
    await verify(s);
    const verified = await claimOf(s);
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: schoolA }).expect(200);
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: schoolA, firstName: 'Same', gradeLevel: 'S3' }).expect(200);
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ role: 'STUDENT', schoolId: schoolA }).expect(200);   // the same role is no role change
    expect(await current(s)).toEqual([expect.objectContaining({ id: verified.id, status: 'VERIFIED', schoolId: schoolA })]);
    expect(await p().studentSchoolAffiliation.count({ where: { studentId: s } })).toBe(1);
    expect(await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', entityId: verified.id } })).toBe(0);
  });

  it('schoolId: null clears the school: the current claim is superseded first (audited with its status), User.schoolId and the enrolment become null, no claim remains', async () => {
    const s = await student(schoolA);
    await verify(s);
    const verified = await claimOf(s);
    const createdAudits = await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_CREATED', metadata: { path: ['studentId'], equals: s } } });

    const res = await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: null }).expect(200);
    expect(res.body.schoolId ?? res.body.school ?? null).toBeNull();
    expect((await p().user.findUniqueOrThrow({ where: { id: s } })).schoolId).toBeNull();
    expect(await current(s)).toEqual([]);
    expect(await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id: verified.id } })).toMatchObject({
      status: 'VERIFIED', schoolId: schoolA, supersedeReason: 'SCHOOL_CHANGE', supersededById: ctx.ids.admin, supersededAt: expect.any(Date),
    });
    const audits = await p().auditLog.findMany({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', entityId: verified.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN' });
    expect(audits[0].metadata).toEqual({ studentId: s, schoolId: schoolA, reason: 'SCHOOL_CHANGE', previous: { status: 'VERIFIED', current: true }, next: { current: false } });
    // No new claim, and no new creation audit.
    expect(await p().studentSchoolAffiliation.count({ where: { studentId: s } })).toBe(1);
    expect(await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_CREATED', metadata: { path: ['studentId'], equals: s } } })).toBe(createdAudits);
    // The current-year enrolment follows the placement.
    expect((await p().studentEnrollment.findFirstOrThrow({ where: { studentId: s, academicYearId: ctx.ids.year } })).schoolId).toBeNull();
    // Clearing again changes nothing; a later school starts a new PENDING claim.
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: null }).expect(200);
    expect(await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', metadata: { path: ['studentId'], equals: s } } })).toBe(1);
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: schoolB }).expect(200);
    expect(await current(s)).toEqual([expect.objectContaining({ schoolId: schoolB, status: 'PENDING', source: 'ADMIN' })]);
    await consistent(s);
  });

  it('an omitted schoolId keeps the school and the claim — a VERIFIED claim stays VERIFIED — whatever else is edited', async () => {
    const s = await student(schoolA);
    await verify(s);
    const verified = await claimOf(s);
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ firstName: 'Kept' }).expect(200);
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ gradeLevel: 'S4' }).expect(200);   // a division change too
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ homeLocation: 'Huye', lastName: 'Same' }).expect(200);
    expect((await p().user.findUniqueOrThrow({ where: { id: s } }))).toMatchObject({ schoolId: schoolA, gradeLevel: 'S4', firstName: 'Kept' });
    expect(await current(s)).toEqual([expect.objectContaining({ id: verified.id, status: 'VERIFIED', schoolId: schoolA })]);
    expect(await p().studentSchoolAffiliation.count({ where: { studentId: s } })).toBe(1);
    expect(await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', metadata: { path: ['studentId'], equals: s } } })).toBe(0);
    expect((await p().studentEnrollment.findFirstOrThrow({ where: { studentId: s, academicYearId: ctx.ids.year } })).schoolId).toBe(schoolA);
  });

  it('a role change and back: the claim ends (ROLE_CHANGE, its previous status audited) and a returning student starts a new PENDING claim', async () => {
    const s = await student(schoolA);
    await verify(s);
    const verified = await claimOf(s);
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
    expect(await current(s)).toEqual([]);
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', entityId: verified.id } });
    expect(audit.metadata).toMatchObject({ reason: 'ROLE_CHANGE', schoolId: schoolA, previous: { status: 'VERIFIED', current: true } });
    await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ role: 'STUDENT', gradeLevel: 'S2', schoolId: schoolB }).expect(200);
    expect(await current(s)).toEqual([expect.objectContaining({ schoolId: schoolB, status: 'PENDING' })]);
    await consistent(s);
  });

  // ─── Stale reads in an Administrator edit (PR #26 review) ──────────────────

  describe('an edit prepared from a stale read never overwrites a change committed meanwhile', () => {
    /**
     * Deterministic interleaving (no parallel connections needed): request B is held right after
     * it has read the user and passed its checks — before its transaction — while request A runs
     * to completion; then B continues.
     */
    async function interleave(first: () => Promise<any>, second: () => Promise<any>) {
      const policy = ctx.app.get(RoleAssignmentPolicy);
      const original = policy.assertCanManage.bind(policy);
      let reached!: () => void; const atGate = new Promise<void>((r) => (reached = r));
      let release!: () => void; const gate = new Promise<void>((r) => (release = r));
      const spy = vi.spyOn(policy, 'assertCanManage').mockImplementationOnce(async (...args: Parameters<typeof original>) => {
        await original(...args);
        reached();
        await gate;
      });
      try {
        const b = second();          // reads the user, then waits at the gate
        await atGate;
        const a = await first();     // commits while B holds its stale read
        release();
        return { a, b: await b };
      } finally {
        spy.mockRestore();
      }
    }

    it('student → Coach committed meanwhile: a stale name-only edit is refused (409), the role and every role cleanup stand', async () => {
      const s = await student(schoolA);
      await verify(s);
      await p().studentEnrollment.create({ data: { studentId: s, academicYearId: ctx.ids.year, gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolA } });
      const { a, b } = await interleave(
        () => http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ role: 'MENTOR' }).then((r) => r),
        () => http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ firstName: 'Stale' }).then((r) => r),
      );
      expect(a.status).toBe(200);
      expect([b.status, b.body.code]).toEqual([409, 'USER_CHANGED_CONCURRENTLY']);
      expect(await p().user.findUniqueOrThrow({ where: { id: s } })).toMatchObject({ role: 'MENTOR', gradeLevel: null, divisionId: null, schoolId: null, firstName: 'A1' });
      expect(await current(s)).toEqual([]);   // the claim ended with the role (ROLE_CHANGE) and was not revived
      expect(await p().studentEnrollment.count({ where: { studentId: s, status: 'ACTIVE' } })).toBe(0);
      expect(await p().auditLog.count({ where: { action: 'UPDATE_USER', entityId: s } })).toBe(1);   // A only
      await consistent(s);
      // Retrying from a fresh read works.
      await http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ firstName: 'Fresh' }).expect(200);
      expect(await p().user.findUniqueOrThrow({ where: { id: s } })).toMatchObject({ role: 'MENTOR', firstName: 'Fresh' });
    });

    it('Administrator demoted meanwhile: a stale name-only edit cannot restore ADMIN (no privilege re-escalation without the role-change checks)', async () => {
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const target = (await p().user.create({ data: {
        username: 'a1.admin.target', firstName: 'Ad', lastName: 'Min', email: 'a1.admin.target@test.local', role: 'ADMIN', passwordHash: hash, activatedAt: new Date(),
      } })).id;
      const { a, b } = await interleave(
        () => http().patch(`/api/v1/admin/users/${target}`).set(bearer(admin)).send({ role: 'MENTOR', currentPassword: PASSWORD }).then((r) => r),
        () => http().patch(`/api/v1/admin/users/${target}`).set(bearer(admin)).send({ lastName: 'Stale' }).then((r) => r),
      );
      expect(a.status).toBe(200);
      expect([b.status, b.body.code]).toEqual([409, 'USER_CHANGED_CONCURRENTLY']);
      expect(await p().user.findUniqueOrThrow({ where: { id: target } })).toMatchObject({ role: 'MENTOR', lastName: 'Min' });
      expect(await p().auditLog.count({ where: { action: 'CHANGE_USER_ROLE', entityId: target } })).toBe(1);
    });

    it('nothing committed in between: the same interleaving helper lets the edit through unchanged', async () => {
      const s = await student(schoolA);
      const { a, b } = await interleave(
        async () => ({ status: 200 }),   // no concurrent change
        () => http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ firstName: 'Calm' }).then((r) => r),
      );
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(await p().user.findUniqueOrThrow({ where: { id: s } })).toMatchObject({ role: 'STUDENT', firstName: 'Calm', schoolId: schoolA });
    });
  });

  // ─── Head Coach views ──────────────────────────────────────────────────────

  it('Head Coach views label the school: VERIFIED only for the school of a current VERIFIED claim; otherwise UNVERIFIED', async () => {
    const verified = await student(schoolA, { programme: true }); await verify(verified);
    const pending = await student(schoolA, { programme: true });
    const revoked = await student(schoolA, { programme: true }); await verify(revoked);
    await http().post(`${A}/${(await claimOf(revoked)).id}/revoke`).set(bearer(admin)).send({ reason: 'Left the school' }).expect(200);
    const noClaim = await student(schoolA, { claim: false, programme: true });
    // Verified at A, but this year's enrolment names B: the enrolment's school is shown, and it is not verified.
    const otherEnrolment = await student(schoolA, { programme: true }); await verify(otherEnrolment);
    await p().studentEnrollment.create({ data: { studentId: otherEnrolment, academicYearId: ctx.ids.year, gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: schoolB } });
    const expected: Record<string, [string, string]> = {
      [verified]: [schoolA, 'VERIFIED'], [pending]: [schoolA, 'UNVERIFIED'], [revoked]: [schoolA, 'UNVERIFIED'], [noClaim]: [schoolA, 'UNVERIFIED'],
    };

    const members = (await http().get(`/api/v1/admin/programmes/${maths}/members`).query({ limit: 100 }).set(bearer(headCoach)).expect(200)).body.data;
    const byId = Object.fromEntries(members.map((m: any) => [m.id, m]));
    for (const [id, [schoolId, verification]] of Object.entries(expected)) expect([id, byId[id]?.school]).toEqual([id, { id: schoolId, name: expect.any(String), verification }]);
    expect(byId[otherEnrolment].school).toMatchObject({ id: schoolA, verification: 'VERIFIED' });   // the user's school, verified
    expect(members.filter((m: any) => m.role !== 'STUDENT').every((m: any) => m.school === null || m.school.verification === 'UNVERIFIED')).toBe(true);

    const report = async (token: string, academicYearId: string) => Object.fromEntries((await http().get('/api/v1/admin/reports/students')
      .query({ academicYearId, limit: 100 }).set(bearer(token)).expect(200)).body.data.map((r: any) => [r.id, r]));
    const all = await report(headCoach, 'all');
    for (const [id, [schoolId, verification]] of Object.entries(expected)) expect([id, all[id]?.school]).toEqual([id, { id: schoolId, name: expect.any(String), verification }]);
    expect(Object.values(all).every((r: any) => !('email' in r))).toBe(true);   // still no contact details for a Head Coach
    // For a year, the school shown is that year's enrolment school — B here — and it is not the verified one.
    expect((await report(headCoach, ctx.ids.year))[otherEnrolment].school).toMatchObject({ id: schoolB, verification: 'UNVERIFIED' });
    // Administrators see the same label.
    expect((await report(admin, 'all'))[verified].school).toMatchObject({ id: schoolA, verification: 'VERIFIED' });
    divergent = otherEnrolment;
  });

  // ─── Concurrency (PostgreSQL in CI) ────────────────────────────────────────

  describe('concurrency', () => {
    const requireConcurrency = async (test: { skip: (note: string) => void }) => {
      if (await servesConcurrentConnections()) return true;
      if (process.env.CI) throw new Error('CI database must serve concurrent connections for this test.');
      test.skip('local single-connection database (prisma dev): runs in CI on PostgreSQL');
      return false;
    };

    it('superseding audits the status the claim had when it was replaced: a verification committing meanwhile is recorded as VERIFIED, not the stale PENDING', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const s = await student(schoolA);
      const id = (await claimOf(s)).id;
      const holder = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
      await holder.connect();
      try {
        // A verification in progress: the row is locked and VERIFIED, not yet committed.
        await holder.query('BEGIN');
        await holder.query(`UPDATE "StudentSchoolAffiliation" SET "status" = 'VERIFIED', "decidedAt" = now(), "decidedById" = $2 WHERE "id" = $1`, [id, ctx.ids.admin]);
        const move = http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: schoolB }).then((r) => r);
        await new Promise((r) => setTimeout(r, 500));   // the edit is now waiting for the claim's row lock
        await holder.query('COMMIT');
        expect((await move).status).toBe(200);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        await holder.end();
      }
      const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', entityId: id } });
      expect(audit.metadata).toMatchObject({ reason: 'SCHOOL_CHANGE', previous: { status: 'VERIFIED', current: true } });
      expect(await p().studentSchoolAffiliation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'VERIFIED', supersedeReason: 'SCHOOL_CHANGE' });
      await consistent(s);
    });

    it('a verification arriving while a school change is in progress gets 409 and nothing is audited', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const s = await student(schoolA);
      const id = (await claimOf(s)).id;
      const adminUser = { id: ctx.ids.admin, role: 'ADMIN', username: 'admin' } as any;
      const results = await Promise.allSettled([
        http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId: schoolB }).then((r) => r.status),
        svc().verify(id, adminUser),
      ]);
      expect(results[0]).toEqual({ status: 'fulfilled', value: 200 });
      const verifiedAudits = await p().auditLog.count({ where: { action: 'SCHOOL_AFFILIATION_VERIFIED', entityId: id } });
      const supersede = await p().auditLog.findFirstOrThrow({ where: { action: 'SCHOOL_AFFILIATION_SUPERSEDED', entityId: id } });
      // Either order is legitimate; the audit always matches what happened.
      if (results[1].status === 'fulfilled') {
        expect(verifiedAudits).toBe(1);
        expect(supersede.metadata).toMatchObject({ previous: { status: 'VERIFIED' } });
      } else {
        expect(verifiedAudits).toBe(0);
        expect(supersede.metadata).toMatchObject({ previous: { status: 'PENDING' } });
        expect((results[1] as PromiseRejectedResult).reason?.response?.code ?? (results[1] as PromiseRejectedResult).reason?.code).toMatch(/AFFILIATION_(SUPERSEDED|STATUS_CONFLICT)/);
      }
      await consistent(s);
    });

    it('simultaneous Administrator edits of one student: each one succeeds or is refused as stale (409, nothing written); the student ends with exactly one current claim, for the school of a successful edit', async (test) => {
      if (!(await requireConcurrency(test))) return;
      const s = await student(schoolA);
      const updates = () => p().auditLog.count({ where: { action: 'UPDATE_USER', entityId: s } });
      for (let round = 0; round < 3; round++) {
        const before = await updates();
        const results = await Promise.all([schoolB, schoolA, schoolB, schoolA, schoolB].map((schoolId) =>
          http().patch(`/api/v1/admin/users/${s}`).set(bearer(admin)).send({ schoolId }).then((r) => ({ schoolId, status: r.status, code: r.body?.code }))));
        // An edit read before another committed is refused rather than overwriting it (USER_CHANGED_CONCURRENTLY).
        for (const r of results) expect([[200, undefined], [409, 'USER_CHANGED_CONCURRENTLY']]).toContainEqual([r.status, r.code]);
        const succeeded = results.filter((r) => r.status === 200);
        expect(succeeded.length).toBeGreaterThanOrEqual(1);
        expect(await updates()).toBe(before + succeeded.length);   // refused edits wrote no audit entry
        const final = (await p().user.findUniqueOrThrow({ where: { id: s } })).schoolId;
        expect(succeeded.map((r) => r.schoolId)).toContain(final);
        await consistent(s);
        expect(await current(s)).toEqual([expect.objectContaining({ schoolId: final })]);
      }
    });
  });

  // ─── Academic-year rollover (last: it changes the current year) ─────────────

  it('an academic-year rollover keeps every affiliation — the same claims, statuses and schools — and Teacher access is unchanged', async () => {
    const mkEnrolled = async (username: string, schoolId: string) => (await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'Roll', lastName: username, username, email: `${username}@test.local`, password: 'Str0ng!Passw0rd', role: 'STUDENT', gradeLevel: 'S2', schoolId,
    }).expect(201)).body.id as string;
    const verified = await mkEnrolled('a1.roll.v', schoolA);
    await verify(verified);
    const pending = await mkEnrolled('a1.roll.p', schoolA);
    const elsewhere = await mkEnrolled('a1.roll.b', schoolB);
    await verify(elsewhere);
    const tracked = [verified, pending, elsewhere];
    const snapshot = async () => Promise.all(tracked.map(async (id) => ({
      claims: await p().studentSchoolAffiliation.findMany({ where: { studentId: id }, orderBy: { createdAt: 'asc' } }),
      schoolId: (await p().user.findUniqueOrThrow({ where: { id } })).schoolId,
    })));
    const listed = async () => (await http().get('/api/v1/teacher/students').query({ limit: 100 }).set(bearer(teacher)).expect(200)).body.data.map((s: any) => s.id);
    const before = await snapshot();
    expect(await listed()).toEqual(expect.arrayContaining([verified]));

    const next = await http().post('/api/v1/admin/academic-years').set(bearer(admin)).send({ name: '2031-2032', startsOn: '2031-09-01', endsOn: '2032-07-31' }).expect(201);
    // A student whose enrolment school differs from their verified school would have their school
    // changed without a claim: M10 refuses the whole rollover, and nothing changes.
    expect(divergent).toBeDefined();
    const refused = await http().post(`/api/v1/admin/academic-years/${next.body.id}/activate`).set(bearer(admin)).send({ promoteStudents: true, expectedCurrentYearId: await currentYearId(ctx) });
    expect([refused.status, refused.body.code]).toEqual([409, 'AFFILIATION_SCHOOL_MISMATCH']);
    expect(await p().academicYear.findUniqueOrThrow({ where: { id: next.body.id } })).toMatchObject({ isCurrent: null, status: 'PLANNED' });
    expect(await p().academicYear.findUniqueOrThrow({ where: { id: ctx.ids.year } })).toMatchObject({ isCurrent: true, status: 'ACTIVE' });
    expect(await snapshot()).toEqual(before);
    await p().studentEnrollment.updateMany({ where: { studentId: divergent, academicYearId: ctx.ids.year }, data: { schoolId: schoolA } });

    const res = await http().post(`/api/v1/admin/academic-years/${next.body.id}/activate`).set(bearer(admin)).send({ promoteStudents: true, expectedCurrentYearId: await currentYearId(ctx) }).expect(200);
    expect(res.body.promoted).toBeGreaterThanOrEqual(3);

    expect(await snapshot()).toEqual(before);
    for (const id of tracked) await consistent(id);
    const after = await listed();
    expect(after).toContain(verified);
    expect(after).not.toContain(pending);
    expect(after).not.toContain(elsewhere);
    await consistent(divergent!);
  });
});
