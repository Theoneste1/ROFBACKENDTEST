/**
 * Coaches across their programmes (owner 2026-11-23), end to end:
 *  - courses: a Coach opens every course of their programme at every level it is offered in (resources too), never
 *    another programme's; grading distribution still uses explicit assignments only;
 *  - students: GET /coach/students lists the programme's students of every level, no contact details;
 *  - marking: a programme member may mark by default; revoking an authorisation, or taking MARKING away, stops it;
 *    authorising again gives it back; a revocation made before the release stays (migration carry-over, by SQL);
 *  - control: an Administrator (every programme) or the programme's Head Coach (only theirs) takes any part away with a
 *    reason and gives it back; audited; a coach outside the programme cannot be changed; coaches cannot change it.
 * (Published results for coaches: test/test-results.e2e-spec.ts.)
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Coaches across their programmes (e2e)', () => {
  let ctx: TestContext;
  let admin: string, hc: string, hcPhys: string, coach: string, coachPhys: string, student: string;
  let maths: string, physics: string, coachId: string, coachPhysId: string, junior: string, senior: string;
  let algebra: string, mechanics: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const PA = (id: string) => `/api/v1/admin/coaches/${id}/programme-access`;
  const set = (token: string, id: string, body: object) => http().put(PA(id)).set(bearer(token)).send(body);

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    physics = (await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics', sortOrder: 1 } })).id;
    junior = ctx.ids.junior; senior = ctx.ids.senior;
    algebra = ctx.ids.algebra;
    mechanics = (await p().course.create({ data: { code: 'MECHANICS', disciplineId: physics, title: 'Mechanics', description: 'Mechanics course', status: 'PUBLISHED', publishedAt: new Date() } })).id;
    // Algebra is offered at Junior and Senior; Mechanics at Junior.
    await p().courseDivision.createMany({ data: [
      { courseId: algebra, divisionId: junior }, { courseId: algebra, divisionId: senior }, { courseId: mechanics, divisionId: junior },
    ], skipDuplicates: true });
    await p().courseDivision.updateMany({ where: { courseId: algebra, divisionId: { in: [junior, senior] } }, data: { isActive: true } });
    // Geometry (Mathematics) is offered at no level in this file: nothing of it to open.
    await p().courseDivision.updateMany({ where: { courseId: ctx.ids.geometry }, data: { isActive: false } });
    await p().courseDivision.updateMany({ where: { courseId: algebra, divisionId: { notIn: [junior, senior] } }, data: { isActive: false } });
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'MENTOR' | 'HEAD_COACH', disciplineId: string) => {
      const u = await p().user.create({ data: { username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } });
      await p().programmeMembership.create({ data: { userId: u.id, disciplineId, source: 'MANUAL' } });
      return u.id;
    };
    // A Mathematics coach with NO course × level assignment; a Physics coach.
    coachId = await mk('cp.maths', 'MENTOR', maths);
    coachPhysId = await mk('cp.phys', 'MENTOR', physics);
    await mk('cp.hc', 'HEAD_COACH', maths);
    await mk('cp.hcphys', 'HEAD_COACH', physics);
    [admin, hc, hcPhys, coach, coachPhys, student] = await Promise.all(['admin', 'cp.hc', 'cp.hcphys', 'cp.maths', 'cp.phys', 'student.j'].map((u) => login(ctx, u)));
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  describe('courses', () => {
    it('a Coach opens every course of their programme at every level it is offered in — without any assignment; never another programme', async () => {
      const list = (await http().get('/api/v1/courses').set(bearer(coach)).expect(200)).body;
      const alg = list.find((c: any) => c.id === algebra);
      expect(alg.divisions.map((d: any) => d.code)).toEqual(['JUNIOR', 'SENIOR']);
      expect(list.map((c: any) => c.id)).not.toContain(mechanics);
      expect((await http().get(`/api/v1/courses/${algebra}`).set(bearer(coach)).expect(200)).body.divisions.map((d: any) => d.code)).toEqual(['JUNIOR', 'SENIOR']);
      await http().get(`/api/v1/courses/${algebra}/resources`).query({ divisionId: senior }).set(bearer(coach)).expect(200);
      expect(await status(http().get(`/api/v1/courses/${mechanics}`).set(bearer(coach)))).toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);
      // Geometry (Mathematics) is offered at no level: nothing to open there.
      expect(await status(http().get(`/api/v1/courses/${ctx.ids.geometry}`).set(bearer(coach)))).toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);
      // The Physics coach gets Mechanics, not Algebra.
      expect((await http().get('/api/v1/courses').set(bearer(coachPhys)).expect(200)).body.map((c: any) => c.id)).toEqual([mechanics]);
      // /me/permissions reports the pairs the coach works in.
      const perms = (await http().get('/api/v1/me/permissions').set(bearer(coach)).expect(200)).body;
      expect(perms.scopes.courseDivisions).toEqual(expect.arrayContaining([{ courseId: algebra, divisionId: junior }, { courseId: algebra, divisionId: senior }]));
      // Grading distribution: the programme coach is not an explicitly assigned coach of the scope.
      expect(await p().mentorAssignment.count({ where: { mentorId: coachId } })).toBe(0);
    });

    it('taken away (Head Coach, with a reason): the programme courses go at once; given back: they return', async () => {
      await set(hc, coachId, { programmeId: maths, capability: 'COURSES', allowed: false, reason: 'Focus on marking this term' }).expect(200);
      expect(await status(http().get(`/api/v1/courses/${algebra}`).set(bearer(coach)))).toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);
      expect((await http().get('/api/v1/courses').set(bearer(coach)).expect(200)).body).toEqual([]);
      await set(hc, coachId, { programmeId: maths, capability: 'COURSES', allowed: true }).expect(200);
      await http().get(`/api/v1/courses/${algebra}`).set(bearer(coach)).expect(200);
    });
  });

  describe('students', () => {
    it("lists the programme's students of every level — no contact details; level filter; never another programme's", async () => {
      await p().user.update({ where: { id: ctx.ids.studentJunior }, data: { phone: '+250788555000', guardianPhone: '+250788555111' } });
      const res = (await http().get('/api/v1/coach/students').set(bearer(coach)).expect(200)).body;
      const expected = await p().user.count({ where: { role: 'STUDENT', accountStatus: 'ACTIVE', programmeMemberships: { some: { disciplineId: maths, isActive: true } } } });
      expect(res.meta.total).toBe(expected);
      expect(res.data.map((s: any) => s.division?.code).sort()).toEqual(expect.arrayContaining(['JUNIOR', 'SENIOR']));
      expect(res.programmes.map((x: any) => x.code)).toEqual(['MATHEMATICS']);
      expect(JSON.stringify(res)).not.toMatch(/788555|email|phone|guardian|dateOfBirth/);
      const seniors = (await http().get('/api/v1/coach/students').query({ division: 'SENIOR' }).set(bearer(coach)).expect(200)).body;
      expect(seniors.data.every((s: any) => s.division.code === 'SENIOR')).toBe(true);
      expect((await http().get('/api/v1/coach/students').set(bearer(coachPhys)).expect(200)).body.meta.total).toBe(0);
      expect(await status(http().get('/api/v1/coach/students').query({ programmeId: physics }).set(bearer(coach)))).toEqual([404, 'NOT_FOUND']);
      // The student overview follows the same rule.
      await http().get(`/api/v1/students/${ctx.ids.studentSenior}/overview`).set(bearer(coach)).expect(200);
      await set(admin, coachId, { programmeId: maths, capability: 'STUDENTS', allowed: false, reason: 'Not needed for this coach' }).expect(200);
      expect((await http().get('/api/v1/coach/students').set(bearer(coach)).expect(200)).body.meta.total).toBe(0);
      expect((await http().get(`/api/v1/students/${ctx.ids.studentSenior}/overview`).set(bearer(coach))).status).toBe(404);
      await set(admin, coachId, { programmeId: maths, capability: 'STUDENTS', allowed: true }).expect(200);
      expect((await http().get('/api/v1/coach/students').set(bearer(coach)).expect(200)).body.meta.total).toBe(expected);
    });

    it('only coaches: others are refused', async () => {
      for (const token of [student, hc, admin]) expect((await http().get('/api/v1/coach/students').set(bearer(token))).status).toBe(403);
    });
  });

  describe('marking', () => {
    const candidate = async (token: string, subjectId: string, id: string) =>
      (await http().get('/api/v1/admin/test-markers/candidates').query({ subjectId, limit: 100 }).set(bearer(token)).expect(200)).body.data.find((c: any) => c.id === id);

    it('a programme member marks by default; revoking an authorisation or taking MARKING away stops it; authorising gives it back', async () => {
      expect(await candidate(hc, maths, coachId)).toMatchObject({ programmeMember: true, authorizationId: null, markingRemoved: null, mayMark: true });
      const dash = async () => (await http().get('/api/v1/admin/test-dashboard').set(bearer(admin)).expect(200)).body;
      const markersOf = (d: any) => d.subjects.find((s: any) => s.subject.id === maths);
      const before = markersOf(await dash());
      expect(before.authorisedMarkers).toBeGreaterThan(0);
      // Take MARKING away: no longer a marker (the dashboard count drops by one).
      await set(hc, coachId, { programmeId: maths, capability: 'MARKING', allowed: false, reason: 'Conflict of interest this round' }).expect(200);
      expect(await candidate(hc, maths, coachId)).toMatchObject({ mayMark: false, markingRemoved: { reason: 'Conflict of interest this round' } });
      expect(markersOf(await dash()).authorisedMarkers).toBe(before.authorisedMarkers - 1);
      // Authorising again gives it back (the restriction is lifted).
      const granted = (await http().post('/api/v1/admin/test-markers').set(bearer(hc)).send({ coachId, subjectId: maths }).expect(201)).body;
      expect(await candidate(hc, maths, coachId)).toMatchObject({ mayMark: true, markingRemoved: null });
      // Revoking that authorisation stops marking for a programme member too (not only the explicit grant).
      await http().post(`/api/v1/admin/test-markers/${granted.id}/revoke`).set(bearer(hc)).send({ reason: 'Stepped down as marker' }).expect(200);
      expect(await candidate(hc, maths, coachId)).toMatchObject({ mayMark: false, markingRemoved: { reason: 'Stepped down as marker' } });
      await set(hc, coachId, { programmeId: maths, capability: 'MARKING', allowed: true }).expect(200);
      expect(await candidate(hc, maths, coachId)).toMatchObject({ mayMark: true });
    });
  });

  const candidateMayMark = async (id: string) =>
    (await http().get('/api/v1/admin/test-markers/candidates').query({ subjectId: maths, limit: 100 }).set(bearer(admin)).expect(200)).body.data.find((c: any) => c.id === id)?.mayMark;

  describe('control', () => {
    it("Administrators (every programme) and the programme's Head Coach (only theirs) see and change it; reasons, audit, history", async () => {
      const view = (await http().get(PA(coachId)).set(bearer(hc)).expect(200)).body;
      expect(view.programmes.map((x: any) => x.programme.code)).toEqual(['MATHEMATICS']);
      expect(view.programmes[0].access.map((a: any) => [a.capability, a.allowed])).toEqual([['STUDENTS', true], ['COURSES', true], ['MARKING', true], ['RESULTS', true]]);
      expect(view.history.length).toBeGreaterThan(0);
      // The Physics Head Coach does not see a Mathematics-only coach; cannot change Mathematics access.
      expect((await http().get(PA(coachId)).set(bearer(hcPhys))).status).toBe(404);
      expect((await set(hcPhys, coachPhysId, { programmeId: maths, capability: 'COURSES', allowed: false, reason: 'x y z' })).status).toBe(403);
      // A programme the coach is not in; a missing reason; a coach changing access; a non-coach.
      expect(await status(set(admin, coachPhysId, { programmeId: maths, capability: 'COURSES', allowed: false, reason: 'Not theirs' }))).toEqual([400, 'NOT_A_PROGRAMME_MEMBER']);
      expect(await status(set(admin, coachId, { programmeId: maths, capability: 'COURSES', allowed: false, reason: ' ' }))).toEqual([400, 'REASON_REQUIRED']);
      expect((await set(coach, coachId, { programmeId: maths, capability: 'COURSES', allowed: true })).status).toBe(403);
      expect((await http().get(PA(ctx.ids.studentJunior)).set(bearer(admin))).status).toBe(404);
      // Idempotent: taking away twice records one restriction; giving back twice records one lift.
      await set(admin, coachId, { programmeId: maths, capability: 'RESULTS', allowed: false, reason: 'Twice' }).expect(200);
      await set(admin, coachId, { programmeId: maths, capability: 'RESULTS', allowed: false, reason: 'Twice' }).expect(200);
      expect(await p().coachProgrammeRestriction.count({ where: { coachId, capability: 'RESULTS', liftedAt: null } })).toBe(1);
      await set(admin, coachId, { programmeId: maths, capability: 'RESULTS', allowed: true }).expect(200);
      await set(admin, coachId, { programmeId: maths, capability: 'RESULTS', allowed: true }).expect(200);
      expect(await p().auditLog.count({ where: { action: 'COACH_PROGRAMME_ACCESS_RESTORED', entityId: coachId, metadata: { path: ['capability'], equals: 'RESULTS' } } })).toBe(1);
    });

    it('the migration carries over a marking authorisation revoked before the release (and only that)', async () => {
      const { readFileSync } = await import('node:fs');
      const sql = readFileSync('prisma/migrations/20261227000000_coach_programme_access/migration.sql', 'utf8');
      const carryOver = sql.slice(sql.indexOf('INSERT INTO "CoachProgrammeRestriction"'));
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const coachOf = async (username: string) => {
        const u = await p().user.create({ data: { username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role: 'MENTOR', passwordHash: hash, activatedAt: new Date() } });
        await p().programmeMembership.create({ data: { userId: u.id, disciplineId: maths, source: 'MANUAL' } });
        return u.id;
      };
      const revoked = await coachOf('cp.revoked');      // revoked, never granted again → carried over
      const regranted = await coachOf('cp.regranted');  // revoked, then granted again → nothing
      await p().markerAuthorization.create({ data: { coachId: revoked, disciplineId: maths, revokedAt: new Date(), revokedById: ctx.ids.admin, revokeReason: 'Left the marking team' } });
      await p().markerAuthorization.create({ data: { coachId: regranted, disciplineId: maths, revokedAt: new Date(Date.now() - 60_000), revokeReason: 'Paused' } });
      await p().markerAuthorization.create({ data: { coachId: regranted, disciplineId: maths } });
      await p().$executeRawUnsafe(carryOver);
      const rows = await p().coachProgrammeRestriction.findMany({ where: { coachId: { in: [revoked, regranted] } } });
      expect(rows.map((r) => [r.coachId, r.capability, r.reason, r.createdById])).toEqual([
        [revoked, 'MARKING', 'Carried over from the revoked marking authorisation: Left the marking team', ctx.ids.admin],
      ]);
      expect(await candidateMayMark(revoked)).toBe(false);
      expect(await candidateMayMark(regranted)).toBe(true);
    });

    it('the database allows one active restriction per coach, programme and part, and a reason', async () => {
      await p().coachProgrammeRestriction.create({ data: { coachId: coachPhysId, disciplineId: physics, capability: 'COURSES', reason: 'First' } });
      await expect(p().coachProgrammeRestriction.create({ data: { coachId: coachPhysId, disciplineId: physics, capability: 'COURSES', reason: 'Second' } })).rejects.toThrow();
      await expect(p().coachProgrammeRestriction.create({ data: { coachId: coachPhysId, disciplineId: physics, capability: 'MARKING', reason: ' ' } })).rejects.toThrow();
    });
  });
});
