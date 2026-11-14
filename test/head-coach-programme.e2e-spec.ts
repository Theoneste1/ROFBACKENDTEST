/**
 * P1-10 — Head Coach programme scope (plan §7.2, §10.1, §11.2, §11.5 scope isolation).
 *
 * Fixtures (plan §11.1): Mathematics (seed) + test-only Physics; head coaches HM
 * (Maths) and HP (Physics); coach B shared by Maths and Physics; coach P in Physics
 * only; a Physics-only student; the seed's Maths students and coaches.
 */
import { AuditService } from '../src/audit/audit.service.js';
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

describe('Head Coach programme scope (P1-10)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, hp: string, coachJ: string, studentJ: string;
  let maths: string, physics: string, mechanics: string;
  let hmId: string, hpId: string, coachB: string, coachP: string, studentP: string;
  let studentFree: string, freeTwo: string, freeRace: string, freeSuspended: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const heads = (id: string) => `/api/v1/admin/programmes/${id}/heads`;
  const members = (id: string) => `/api/v1/admin/programmes/${id}/members`;
  const candidates = (id: string) => `/api/v1/admin/programmes/${id}/student-candidates`;
  const ASSIGN = '/api/v1/admin/mentor-assignments';

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coachJ = await login(ctx, 'mentor.j');
    studentJ = await login(ctx, 'student.j');
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    physics = (await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics' } })).id;   // test database only
    mechanics = (await p().course.create({ data: {
      code: 'MECHANICS', disciplineId: physics, title: 'Mechanics', description: 'Physics course', status: 'PUBLISHED', publishedAt: new Date(),
    } })).id;

    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'HEAD_COACH' | 'MENTOR' | 'STUDENT', programmes: string[]) => {
      const u = await p().user.create({ data: {
        username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date(),
        ...(role === 'STUDENT' && { gradeLevel: 'S2', divisionId: ctx.ids.junior }),
      } });
      for (const disciplineId of programmes) await p().programmeMembership.create({ data: { userId: u.id, disciplineId, source: 'MANUAL' } });
      return u.id;
    };
    hmId = await mk('hc.maths', 'HEAD_COACH', []);
    hpId = await mk('hc.phys', 'HEAD_COACH', []);
    coachB = await mk('coach.b', 'MENTOR', [maths, physics]);
    coachP = await mk('coach.p', 'MENTOR', [physics]);
    studentP = await mk('student.p', 'STUDENT', [physics]);
    // Students in no programme (2026-11-14: the only students a Head Coach may find and add).
    studentFree = await mk('student.free', 'STUDENT', []);
    freeTwo = await mk('free.two', 'STUDENT', []);
    freeRace = await mk('free.race', 'STUDENT', []);
    freeSuspended = await mk('free.suspended', 'STUDENT', []);
    await p().user.update({ where: { id: freeSuspended }, data: { isActive: false } });
    await p().mentorAssignment.create({ data: { mentorId: coachP, courseId: mechanics, divisionId: ctx.ids.junior } });
    hm = await login(ctx, 'hc.maths');
    hp = await login(ctx, 'hc.phys');
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('programme list: readable by roles that view courses; anonymous 401', async () => {
    const list = await http().get('/api/v1/programmes').set(bearer(studentJ)).expect(200);
    expect(list.body.map((d: any) => d.code).sort()).toEqual(['MATHEMATICS', 'PHYSICS']);
    await http().get('/api/v1/programmes').set(bearer(hm)).expect(200);
    expect((await http().get('/api/v1/programmes')).status).toBe(401);
  });

  it('heads: only an Administrator sets them (exact list, audited); Head Coaches, coaches and students are refused; only HEAD_COACH users qualify', async () => {
    for (const token of [hm, coachJ, studentJ]) {
      expect(await status(http().put(heads(maths)).set(bearer(token)).send({ userIds: [hmId] }))).toEqual([403, 'PERMISSION_REQUIRED']);
      expect(await status(http().get(heads(maths)).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
    }
    // Not a Head Coach → 400, nothing written.
    expect(await status(http().put(heads(maths)).set(bearer(admin)).send({ userIds: [hmId, ctx.ids.mentorJunior] }))).toEqual([400, 'NOT_A_HEAD_COACH']);
    expect(await p().programmeMembership.count({ where: { userId: hmId } })).toBe(0);
    // Unknown programme → 404.
    expect((await http().put(heads('00000000-0000-4000-8000-000000000000')).set(bearer(admin)).send({ userIds: [] })).status).toBe(404);

    const set = await http().put(heads(maths)).set(bearer(admin)).send({ userIds: [hmId] }).expect(200);
    expect(set.body.map((h: any) => h.id)).toEqual([hmId]);
    await http().put(heads(physics)).set(bearer(admin)).send({ userIds: [hpId] }).expect(200);
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'PROGRAMME_HEADS_SET', entityId: maths } });
    expect(audit).toMatchObject({ actorId: ctx.ids.admin, metadata: { added: [hmId], removed: [], previous: [], next: [hmId] } });
    // Idempotent: the same list again changes nothing and writes no audit row.
    await http().put(heads(maths)).set(bearer(admin)).send({ userIds: [hmId] }).expect(200);
    expect(await p().auditLog.count({ where: { action: 'PROGRAMME_HEADS_SET', entityId: maths } })).toBe(1);
  });

  it('/me/permissions shows the programmes a Head Coach heads; nobody else has programme scope', async () => {
    expect((await http().get('/api/v1/me/permissions').set(bearer(hm)).expect(200)).body.scopes.programmes).toEqual([maths]);
    expect((await http().get('/api/v1/me/permissions').set(bearer(hp)).expect(200)).body.scopes.programmes).toEqual([physics]);
    for (const token of [admin, coachJ, studentJ]) {
      expect((await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200)).body.scopes.programmes).toEqual([]);
    }
  });

  it('scope isolation: a Head Coach sees only students and coaches of programmes they head — no staff accounts, no contact details; other programmes 404', async () => {
    const res = await http().get(members(maths)).set(bearer(hm)).query({ limit: 100 }).expect(200);
    const ids = res.body.data.map((m: any) => m.id);
    expect(ids).toEqual(expect.arrayContaining([ctx.ids.studentJunior, ctx.ids.mentorJunior, coachB]));
    for (const hidden of [studentP, coachP, hmId, hpId, ctx.ids.admin]) expect(ids).not.toContain(hidden);
    expect(new Set(res.body.data.map((m: any) => m.role))).toEqual(new Set(['STUDENT', 'MENTOR']));
    for (const m of res.body.data) {
      for (const key of ['email', 'phone', 'passwordHash', 'homeLocation']) expect([m.id, key in m]).toEqual([m.id, false]);
    }
    const student = res.body.data.find((m: any) => m.id === ctx.ids.studentJunior);
    expect(student).toMatchObject({ gradeLevel: 'S2', division: { id: ctx.ids.junior }, school: { name: 'Test School' }, membership: { isActive: true } });

    // The shared coach B appears to both heads; P only to Physics.
    const phys = (await http().get(members(physics)).set(bearer(hp)).query({ limit: 100 }).expect(200)).body.data.map((m: any) => m.id);
    expect(phys.sort()).toEqual([coachB, coachP, studentP].sort());

    // Other programme → 404 for each head; former members are not listed to a Head Coach.
    expect((await http().get(members(physics)).set(bearer(hm))).status).toBe(404);
    expect((await http().get(members(maths)).set(bearer(hp))).status).toBe(404);
    expect(await status(http().get(members(maths)).set(bearer(hm)).query({ isActive: 'false' }))).toEqual([403, 'SCOPE_FORBIDDEN']);
    // Coaches and students have no access; an Administrator sees every programme.
    for (const token of [coachJ, studentJ]) expect(await status(http().get(members(maths)).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
    await http().get(members(physics)).set(bearer(admin)).expect(200);
  });

  it('membership changes: a Head Coach adds/ends STUDENTS in their own programme only (audited); coaches 403; staff and others not revealed (404)', async () => {
    // 2026-11-14: a student who is an active member of another programme is refused (an Administrator moves them).
    expect(await status(http().post(members(maths)).set(bearer(hm)).send({ userId: studentP }))).toEqual([409, 'STUDENT_IN_OTHER_PROGRAMME']);
    expect(await p().programmeMembership.count({ where: { userId: studentP, disciplineId: maths } })).toBe(0);

    // Add a student who is in no programme.
    const added = await http().post(members(maths)).set(bearer(hm)).send({ userId: studentFree }).expect(201);
    expect(added.body).toMatchObject({ id: studentFree, membership: { isActive: true, source: 'MANUAL' } });
    expect('email' in added.body).toBe(false);
    expect(await status(http().post(members(maths)).set(bearer(hm)).send({ userId: studentFree }))).toEqual([409, 'ALREADY_MEMBER']);
    const addAudit = await p().auditLog.findFirstOrThrow({ where: { action: 'PROGRAMME_MEMBER_ADD', actorId: hmId } });
    expect(addAudit).toMatchObject({ actorRole: 'HEAD_COACH', metadata: { disciplineId: maths, userId: studentFree, role: 'STUDENT', reactivated: false } });

    // End, end again (409), re-add (the same row is re-activated).
    await http().delete(`${members(maths)}/${studentFree}`).set(bearer(hm)).expect(200);
    expect(await status(http().delete(`${members(maths)}/${studentFree}`).set(bearer(hm)))).toEqual([409, 'MEMBERSHIP_ENDED']);
    await http().post(members(maths)).set(bearer(hm)).send({ userId: studentFree }).expect(201);
    expect(await p().programmeMembership.count({ where: { userId: studentFree, disciplineId: maths } })).toBe(1);
    expect(await p().auditLog.count({ where: { action: 'PROGRAMME_MEMBER_END', actorId: hmId } })).toBe(1);

    // Coaches: Administrator only (403); staff / Head Coaches / unknown users: not revealed (404).
    expect(await status(http().post(members(maths)).set(bearer(hm)).send({ userId: coachP }))).toEqual([403, 'SCOPE_FORBIDDEN']);
    expect(await status(http().delete(`${members(maths)}/${coachB}`).set(bearer(hm)))).toEqual([403, 'SCOPE_FORBIDDEN']);
    for (const target of [ctx.ids.admin, hpId, hmId, '00000000-0000-4000-8000-000000000000']) {
      expect([target, (await http().post(members(maths)).set(bearer(hm)).send({ userId: target })).status]).toEqual([target, 404]);
    }
    // Another programme: 404, nothing written.
    expect((await http().post(members(physics)).set(bearer(hm)).send({ userId: ctx.ids.studentJunior })).status).toBe(404);
    expect((await http().delete(`${members(physics)}/${studentP}`).set(bearer(hm))).status).toBe(404);
    expect(await p().programmeMembership.count({ where: { userId: ctx.ids.studentJunior, disciplineId: physics } })).toBe(0);
    expect((await p().programmeMembership.findUniqueOrThrow({ where: { userId_disciplineId: { userId: studentP, disciplineId: physics } } })).isActive).toBe(true);

    // Administrators: students and coaches — including a student of another programme (cross-programme
    // moves are theirs); Head Coaches only through the heads endpoint.
    await http().post(members(maths)).set(bearer(admin)).send({ userId: studentP }).expect(201);
    await http().delete(`${members(maths)}/${studentP}`).set(bearer(admin)).expect(200);
    await http().post(members(maths)).set(bearer(admin)).send({ userId: coachP }).expect(201);
    expect(await status(http().post(members(maths)).set(bearer(admin)).send({ userId: hpId }))).toEqual([400, 'ROLE_NOT_MEMBER']);
    await http().delete(`${members(maths)}/${coachP}`).set(bearer(admin)).expect(200);
  });

  it('student candidates (2026-11-14): a Head Coach finds only students in no programme, in programmes they head; no contact details; Administrators see every student not in the programme', async () => {
    const find = (token: string, id: string, search: string) => http().get(candidates(id)).set(bearer(token)).query({ search, limit: 100 });
    const ids = (r: any) => r.body.data.map((u: any) => u.id);

    // Head Coach, own programme: only active students in no programme match.
    const hmRes = await find(hm, maths, 'free').expect(200);
    expect(ids(hmRes)).toEqual(expect.arrayContaining([freeTwo, freeRace]));
    for (const hidden of [studentFree /* in Maths */, freeSuspended /* suspended */]) expect(ids(hmRes)).not.toContain(hidden);
    const all = await find(hm, maths, 'st').expect(200);
    for (const hidden of [studentP, ctx.ids.studentJunior, studentFree, coachP, coachB, hmId, hpId, ctx.ids.admin]) {
      expect([hidden, ids(all).includes(hidden)]).toEqual([hidden, false]);
    }
    expect(new Set(all.body.data.map((u: any) => u.role))).toEqual(new Set(['STUDENT']));
    // D7: name, username, grade, division, school — never contact details.
    for (const u of [...hmRes.body.data, ...all.body.data]) {
      for (const key of ['email', 'phone', 'homeLocation', 'passwordHash', 'membership']) expect([u.id, key in u]).toEqual([u.id, false]);
    }
    expect(hmRes.body.data.find((u: any) => u.id === freeTwo)).toMatchObject({ username: 'free.two', gradeLevel: 'S2', division: { id: ctx.ids.junior } });
    expect(hmRes.body.meta).toMatchObject({ page: 1, limit: 100 });
    // Matching by name or username, case-insensitive; e-mail addresses are not searched.
    expect(ids(await find(hm, maths, 'FREE.TWO').expect(200))).toEqual([freeTwo]);
    expect(ids(await find(hm, maths, 'free.two@test').expect(200))).toEqual([]);

    // Another programme: 404 for a Head Coach; coaches and students: 403; validation: 400.
    expect((await find(hm, physics, 'free')).status).toBe(404);
    expect((await find(hp, maths, 'free')).status).toBe(404);
    for (const token of [coachJ, studentJ]) expect(await status(find(token, maths, 'free'))).toEqual([403, 'PERMISSION_REQUIRED']);
    for (const search of ['a', ' a ', 'x'.repeat(101)]) expect([search.length, (await find(hm, maths, search)).status]).toEqual([search.length, 400]);
    expect((await http().get(candidates(maths)).set(bearer(hm))).status).toBe(400);
    expect((await find(admin, '00000000-0000-4000-8000-000000000000', 'free')).status).toBe(404);

    // Administrator: every active student not in THIS programme, whatever their other memberships.
    const adminPhys = await find(admin, physics, 'st').expect(200);
    expect(ids(adminPhys)).toEqual(expect.arrayContaining([ctx.ids.studentJunior, studentFree]));
    expect(ids(adminPhys)).not.toContain(studentP);

    // Add from the search; the student then disappears from every Head Coach's search, and the other
    // programme's Head Coach cannot add them (409).
    await http().post(members(maths)).set(bearer(hm)).send({ userId: freeTwo }).expect(201);
    expect(ids(await find(hm, maths, 'free').expect(200))).not.toContain(freeTwo);
    expect(ids(await find(hp, physics, 'free').expect(200))).not.toContain(freeTwo);
    expect(await status(http().post(members(physics)).set(bearer(hp)).send({ userId: freeTwo }))).toEqual([409, 'STUDENT_IN_OTHER_PROGRAMME']);
    expect(await p().programmeMembership.count({ where: { userId: freeTwo, disciplineId: physics } })).toBe(0);
  });

  it('student candidates (2026-11-14): two Head Coaches adding the same free student at once — exactly one programme gets them', async () => {
    const results = await Promise.all([
      http().post(members(maths)).set(bearer(hm)).send({ userId: freeRace }),
      http().post(members(physics)).set(bearer(hp)).send({ userId: freeRace }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('STUDENT_IN_OTHER_PROGRAMME');
    expect(await p().programmeMembership.count({ where: { userId: freeRace, isActive: true } })).toBe(1);
  });

  it('D-5 (2026-11-14): an Administrator\'s /me/permissions reports the Head Coach administration it holds — never Super Admin powers', async () => {
    const perms: string[] = (await http().get('/api/v1/me/permissions').set(bearer(admin)).expect(200)).body.permissions;
    for (const p of ['users.manageHeadCoaches', 'programmes.manageHeads', 'programmes.manageMembers', 'coaches.monitor', 'reports.view']) {
      expect([p, perms.includes(p)]).toEqual([p, true]);
    }
    for (const p of ['users.manageAdmins', 'permissions.manageOverrides', 'settings.manageSystem', 'schools.syncDirectory']) {
      expect([p, perms.includes(p)]).toEqual([p, false]);
    }
    // What the list reports, the API allows: a Head Coach account, then programme head.
    const hc = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'Dfive', lastName: 'Head', username: 'd5.head', email: 'd5.head@test.local', password: 'Str0ng!Passw0rd', role: 'HEAD_COACH',
    }).expect(201);
    await http().put(heads(physics)).set(bearer(admin)).send({ userIds: [hpId, hc.body.id] }).expect(200);
    await http().get('/api/v1/admin/reports/mentors').set(bearer(admin)).expect(200);
    // Never SUPER_ADMIN: not on creation, not by a role change.
    expect((await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'Dfive', lastName: 'Super', username: 'd5.super', email: 'd5.super@test.local', password: 'Str0ng!Passw0rd', role: 'SUPER_ADMIN',
    })).status).toBe(403);
    expect((await http().patch(`/api/v1/admin/users/${hc.body.id}`).set(bearer(admin)).send({ role: 'SUPER_ADMIN', currentPassword: PASSWORD })).status).toBe(403);
    expect((await p().user.findUniqueOrThrow({ where: { id: hc.body.id } })).role).toBe('HEAD_COACH');
    await http().put(heads(physics)).set(bearer(admin)).send({ userIds: [hpId] }).expect(200);
  });

  it('coach assignments: a Head Coach assigns member Coaches to their programme\'s courses — never themselves, another Head Coach or an Administrator; other programmes 404', async () => {
    const body = (mentorId: string, courseId = ctx.ids.geometry) => ({ mentorId, courseId, divisionId: ctx.ids.junior });

    // List: only Maths course assignments of Coaches (the seed's Algebra ones), never Physics.
    const list = await http().get(ASSIGN).set(bearer(hm)).query({ limit: 100 }).expect(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    for (const a of list.body.data) expect(a.course.id).not.toBe(mechanics);
    // No contact details for a Head Coach (D7): coaches are listed without their e-mail.
    for (const a of list.body.data) expect('email' in a.mentor).toBe(false);
    expect((await http().get(ASSIGN).set(bearer(admin)).query({ limit: 1 }).expect(200)).body.data[0].mentor.email).toBeTruthy();
    expect((await http().get(ASSIGN).set(bearer(hp)).query({ limit: 100 }).expect(200)).body.data.map((a: any) => a.mentor.id)).toEqual([coachP]);

    // Forbidden assignees: 403, nothing written.
    for (const target of [hmId, hpId, ctx.ids.admin]) {
      expect([target, ...(await status(http().post(ASSIGN).set(bearer(hm)).send(body(target))))]).toEqual([target, 403, 'SCOPE_FORBIDDEN']);
    }
    // A Coach outside the programme, or a course in another programme: 404.
    expect((await http().post(ASSIGN).set(bearer(hm)).send(body(coachP))).status).toBe(404);
    expect((await http().post(ASSIGN).set(bearer(hm)).send(body(coachB, mechanics))).status).toBe(404);
    expect(await p().mentorAssignment.count({ where: { OR: [{ mentorId: { in: [hmId, hpId, ctx.ids.admin] } }, { mentorId: coachP, courseId: ctx.ids.geometry }, { mentorId: coachB }] } })).toBe(0);

    // A member Coach on a programme course: assigned, audited as the Head Coach; the coach then has that scope.
    const created = await http().post(ASSIGN).set(bearer(hm)).send(body(coachB)).expect(201);
    expect(created.body).toMatchObject({ isActive: true, assignedBy: { id: hmId }, course: { id: ctx.ids.geometry } });
    expect('email' in created.body.mentor).toBe(false);
    expect(await p().auditLog.count({ where: { action: 'ASSIGN_MENTOR', actorId: hmId, entityId: created.body.id } })).toBe(1);
    const coachBToken = await login(ctx, 'coach.b');
    const teaching = (await http().get('/api/v1/me/teaching').set(bearer(coachBToken)).expect(200)).body;
    expect(teaching.map((t: any) => t.course.id)).toEqual([ctx.ids.geometry]);

    // Unassign: own programme only.
    const physicsAssignment = await p().mentorAssignment.findFirstOrThrow({ where: { mentorId: coachP, courseId: mechanics } });
    expect((await http().delete(`${ASSIGN}/${physicsAssignment.id}`).set(bearer(hm))).status).toBe(404);
    expect((await p().mentorAssignment.findUniqueOrThrow({ where: { id: physicsAssignment.id } })).isActive).toBe(true);
    await http().delete(`${ASSIGN}/${created.body.id}`).set(bearer(hm)).expect(200);
    expect((await p().mentorAssignment.findUniqueOrThrow({ where: { id: created.body.id } })).isActive).toBe(false);

    // Coaches and students: still refused (permission), as before.
    for (const token of [coachJ, studentJ]) expect(await status(http().get(ASSIGN).set(bearer(token)))).toEqual([403, 'PERMISSION_REQUIRED']);
  });

  it('coach assignments: a failing audit write rolls back assign (new and re-activated) and unassign — Head Coach and Administrator paths', async () => {
    const audit = ctx.app.get(AuditService);
    const failNextAudit = () => vi.spyOn(audit, 'log').mockImplementationOnce(async () => { throw new Error('audit unavailable'); });
    const body = { mentorId: coachB, courseId: ctx.ids.algebra, divisionId: ctx.ids.senior };
    const row = () => p().mentorAssignment.findUnique({ where: { mentorId_courseId_divisionId: body } });
    const audits = () => p().auditLog.count({ where: { action: { in: ['ASSIGN_MENTOR', 'UNASSIGN_MENTOR'] } } });
    const before = await audits();

    for (const [label, token] of [['Head Coach', hm], ['Administrator', admin]] as const) {
      // New assignment: nothing is created.
      let spy = failNextAudit();
      try { expect([label, (await http().post(ASSIGN).set(bearer(token)).send(body)).status]).toEqual([label, 500]); } finally { spy.mockRestore(); }
      expect([label, await row()]).toEqual([label, null]);

      // Unassign: the assignment stays active.
      const created = await http().post(ASSIGN).set(bearer(token)).send(body).expect(201);
      spy = failNextAudit();
      try { expect([label, (await http().delete(`${ASSIGN}/${created.body.id}`).set(bearer(token))).status]).toEqual([label, 500]); } finally { spy.mockRestore(); }
      expect([label, (await row())?.isActive]).toEqual([label, true]);

      // Re-activating an ended assignment: it stays ended.
      await http().delete(`${ASSIGN}/${created.body.id}`).set(bearer(token)).expect(200);
      spy = failNextAudit();
      try { expect([label, (await http().post(ASSIGN).set(bearer(token)).send(body)).status]).toEqual([label, 500]); } finally { spy.mockRestore(); }
      expect([label, (await row())?.isActive]).toEqual([label, false]);

      await p().mentorAssignment.delete({ where: { id: created.body.id } });
    }
    // Only the successful changes were audited: per path one assign and one unassign.
    expect(await audits()).toBe(before + 4);
  });

  it('a change of heads applies on the Head Coach\'s next request, without re-login', async () => {
    await http().put(heads(maths)).set(bearer(admin)).send({ userIds: [] }).expect(200);
    expect((await http().get(members(maths)).set(bearer(hm))).status).toBe(404);
    expect((await http().get(ASSIGN).set(bearer(hm)).expect(200)).body.data).toEqual([]);
    expect((await http().get('/api/v1/me/permissions').set(bearer(hm)).expect(200)).body.scopes.programmes).toEqual([]);
    const ended = await p().programmeMembership.findUniqueOrThrow({ where: { userId_disciplineId: { userId: hmId, disciplineId: maths } } });
    expect(ended).toMatchObject({ isActive: false, endedById: ctx.ids.admin });
    await http().put(heads(maths)).set(bearer(admin)).send({ userIds: [hmId] }).expect(200);
    await http().get(members(maths)).set(bearer(hm)).expect(200);
  });

  it('escalation: promoting a coach to Head Coach does not make them head of their former programmes (memberships end, audited)', async () => {
    const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'Promo', lastName: 'Coach', username: 'promo.coach', email: 'promo.coach@test.local', password: 'Str0ng!Passw0rd', role: 'MENTOR',
    }).expect(201);
    const id: string = created.body.id;
    await p().programmeMembership.upsert({
      where: { userId_disciplineId: { userId: id, disciplineId: maths } },
      create: { userId: id, disciplineId: maths, source: 'MANUAL' }, update: { isActive: true },
    });
    await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'HEAD_COACH' }).expect(200);

    expect(await p().programmeMembership.count({ where: { userId: id, isActive: true } })).toBe(0);
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'PROGRAMME_MEMBERSHIPS_ENDED', entityId: id } });
    expect(audit.metadata).toMatchObject({ reason: 'ROLE_CHANGE', from: 'MENTOR', to: 'HEAD_COACH', disciplineIds: [maths] });
    const token = await login(ctx, 'promo.coach', 'Str0ng!Passw0rd');
    expect((await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200)).body.scopes.programmes).toEqual([]);
    expect((await http().get(members(maths)).set(bearer(token))).status).toBe(404);

    // Demotion back: a former head keeps no membership either.
    await http().put(heads(maths)).set(bearer(admin)).send({ userIds: [hmId, id] }).expect(200);
    await http().patch(`/api/v1/admin/users/${id}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
    expect(await p().programmeMembership.count({ where: { userId: id, isActive: true } })).toBe(0);
    expect((await http().get(heads(maths)).set(bearer(admin)).expect(200)).body.map((h: any) => h.id)).toEqual([hmId]);
  });

  it('Head Coach still has no global administration; monitoring is programme-scoped and exports stay closed', async () => {
    for (const make of [
      () => http().get('/api/v1/admin/users'),
      () => http().get('/api/v1/admin/audit-logs'),
      () => http().put(heads(maths)).send({ userIds: [hmId] }),
      () => http().get('/api/v1/admin/email/jobs'),
    ]) expect(await status(make().set(bearer(hm)))).toEqual([403, 'PERMISSION_REQUIRED']);
    // P1-10 part 3: dashboard, reports and activity are open for the programmes headed (details in
    // head-coach-monitoring.e2e-spec.ts); exports (reports.export, H8) stay closed.
    for (const path of ['/api/v1/admin/dashboard', '/api/v1/admin/reports/students', '/api/v1/admin/activity']) {
      expect([path, (await http().get(path).set(bearer(hm))).status]).toEqual([path, 200]);
    }
    expect(await status(http().get('/api/v1/admin/reports/students.csv').set(bearer(hm)))).toEqual([403, 'PERMISSION_REQUIRED']);
  });
});
