/**
 * Primary teacher of a school (owner decision 2026-11-19): the school's designated MAIN CONTACT only — primary and
 * secondary teachers have exactly the same rights.
 *
 *   - the first teacher an Administrator links to a school without an active primary (approved application or direct
 *     assignment) is PRIMARY; later ones SECONDARY; concurrent approvals never create two (partial unique index +
 *     the school's primary lock);
 *   - Administrators (users.manageTeachers) reassign atomically, audited (TEACHER_PRIMARY_ASSIGNED); nobody else can;
 *   - ending the primary's link, or the account leaving ACTIVE, leaves the school WITHOUT a primary (never promoted).
 */
import { createTestApp, login, bearer, PASSWORD, type TestContext } from './helpers.js';

const ASSIGN = '/api/v1/admin/teacher-assignments';
const APPS = '/api/v1/admin/teacher-applications';

describe('Primary teacher of a school (owner decision 2026-11-19)', () => {
  let ctx: TestContext;
  let admin: string, coach: string, student: string;
  let hash: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  let seq = 0;
  const school = async (name: string) => (await p().school.create({ data: {
    name, code: String(330000 + ++seq), nameKey: name.toLowerCase(), location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST',
    province: 'Southern Province', district: 'Huye', sector: 'Ngoma', countryCode: 'RW',
  } })).id;
  const teacher = async (username: string) => (await p().user.create({ data: {
    username, firstName: username, lastName: 'Teacher', email: `${username}@test.local`, role: 'TEACHER', passwordHash: hash, activatedAt: new Date(),
  } })).id;
  const assign = (teacherId: string, schoolId: string, token = admin) => http().post(ASSIGN).set(bearer(token)).send({ teacherId, schoolId });
  const makePrimary = (assignmentId: string, token = admin) => http().post(`${ASSIGN}/${assignmentId}/primary`).set(bearer(token)).send();
  const linksOf = async (schoolId: string) => p().teacherSchoolAssignment.findMany({
    where: { schoolId }, select: { id: true, teacherId: true, isActive: true, role: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const primaryOf = async (schoolId: string) => (await p().teacherSchoolAssignment.findMany({ where: { schoolId, isActive: true, role: 'PRIMARY' } })).map((l) => l.teacherId);
  const application = (username: string, schoolId: string) => p().teacherApplication.create({ data: {
    firstName: username, lastName: 'Applicant', username, email: `${username}@test.local`, passwordHash: hash, phone: '+250788123456',
    country: 'RW', olympiadInterests: ['MATHEMATICS'], schoolId, schoolProvince: 'Southern Province', schoolDistrict: 'Huye',
    schoolSector: 'Ngoma', homeProvince: 'Southern Province', homeDistrict: 'Huye', homeSector: 'Ngoma',
  } }).then((a) => a.id);
  const approve = (id: string) => http().post(`${APPS}/${id}/approve`).set(bearer(admin)).send({});

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    [admin, coach, student] = await Promise.all(['admin', 'mentor.j', 'student.j'].map((u) => login(ctx, u)));
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('direct assignment: the first teacher of a school is PRIMARY, later ones SECONDARY; the list returns and filters by role', async () => {
    const s = await school('gs primary direct');
    const [a, b, c] = await Promise.all(['pt.a', 'pt.b', 'pt.c'].map(teacher));
    expect((await assign(a, s).expect(201)).body).toMatchObject({ role: 'PRIMARY', isActive: true, teacher: { id: a } });
    expect((await assign(b, s).expect(201)).body).toMatchObject({ role: 'SECONDARY' });
    expect((await assign(c, s).expect(201)).body).toMatchObject({ role: 'SECONDARY' });
    const all = (await http().get(ASSIGN).query({ schoolId: s }).set(bearer(admin)).expect(200)).body.data;
    expect(all.map((r: any) => [r.teacher.id, r.role])).toEqual([[a, 'PRIMARY'], [b, 'SECONDARY'], [c, 'SECONDARY']]);
    const primary = (await http().get(ASSIGN).query({ schoolId: s, isActive: true, role: 'PRIMARY' }).set(bearer(admin)).expect(200)).body;
    expect(primary.data.map((r: any) => r.teacher.id)).toEqual([a]);
    expect(primary.meta.total).toBe(1);
    expect((await http().get(ASSIGN).query({ schoolId: s, role: 'SECONDARY' }).set(bearer(admin)).expect(200)).body.data).toHaveLength(2);
    expect(await status(http().get(ASSIGN).query({ schoolId: s, role: 'MAIN' }).set(bearer(admin)))).toEqual([400, 'VALIDATION_FAILED']);
    // A teacher primary at one school can be secondary at another: the role belongs to the link.
    const s2 = await school('gs primary second school');
    await assign(b, s2).expect(201);
    expect(await primaryOf(s2)).toEqual([b]);
    // The audit row of each assignment records the role it was given.
    const audit = await p().auditLog.findMany({ where: { action: 'ASSIGN_TEACHER_SCHOOL', metadata: { path: ['schoolId'], equals: s } }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((x) => (x.metadata as any).role).sort()).toEqual(['PRIMARY', 'SECONDARY', 'SECONDARY']);
  });

  it('approval: the first APPROVED teacher of a school becomes PRIMARY, later ones SECONDARY', async () => {
    const s = await school('gs primary approval');
    const first = await application('pt.app1', s);
    const second = await application('pt.app2', s);
    // Submitting creates no link: only the approval does.
    expect(await linksOf(s)).toEqual([]);
    const r2 = await approve(second).expect(200);   // approved first, though submitted second
    const r1 = await approve(first).expect(200);
    expect(await primaryOf(s)).toEqual([r2.body.teacher.id]);
    const links = await linksOf(s);
    expect(links.find((l) => l.teacherId === r1.body.teacher.id)?.role).toBe('SECONDARY');
    const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'APPROVE_TEACHER_APPLICATION', entityId: second } });
    expect(audit.metadata).toMatchObject({ role: 'PRIMARY', schoolId: s });
  });

  it('concurrent approvals and assignments for one school never create two primaries (every request succeeds)', async () => {
    const s = await school('gs primary race');
    const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => application(`pt.race${i}`, s)));
    const res = await Promise.all(ids.map((id) => approve(id)));
    expect(res.map((r) => r.status)).toEqual(ids.map(() => 200));
    const links = await linksOf(s);
    expect(links).toHaveLength(6);
    expect(links.filter((l) => l.role === 'PRIMARY')).toHaveLength(1);

    const s2 = await school('gs primary race direct');
    const teachers = await Promise.all(Array.from({ length: 6 }, (_, i) => teacher(`pt.direct${i}`)));
    const direct = await Promise.all(teachers.map((t) => assign(t, s2)));
    expect(direct.map((r) => r.status)).toEqual(teachers.map(() => 201));
    expect(direct.filter((r) => r.body.role === 'PRIMARY')).toHaveLength(1);
    expect(await primaryOf(s2)).toHaveLength(1);
  });

  it('the database refuses a second active primary for a school (partial unique index), whatever the application does', async () => {
    const s = await school('gs primary index');
    const [a, b] = await Promise.all(['pt.idx1', 'pt.idx2'].map(teacher));
    await assign(a, s).expect(201);
    const second = (await assign(b, s).expect(201)).body.id;
    await expect(p().teacherSchoolAssignment.update({ where: { id: second }, data: { role: 'PRIMARY' } })).rejects.toMatchObject({ code: 'P2002' });
    // An ENDED primary does not count: the index covers active links only.
    const ended = await p().teacherSchoolAssignment.create({ data: { teacherId: await teacher('pt.idx3'), schoolId: s, isActive: false, role: 'PRIMARY' } });
    expect(ended.role).toBe('PRIMARY');
    expect(await primaryOf(s)).toEqual([a]);
  });

  it('reassignment: an Administrator makes a secondary teacher primary; the previous primary becomes secondary, atomically and audited', async () => {
    const s = await school('gs primary reassign');
    const [a, b] = await Promise.all(['pt.r1', 'pt.r2'].map(teacher));
    const la = (await assign(a, s).expect(201)).body.id;
    const lb = (await assign(b, s).expect(201)).body.id;
    const tB = await login(ctx, 'pt.r2');
    const tA = await login(ctx, 'pt.r1');
    // Ordinary teachers — primary or not — coaches and students can never reassign (no new permission exists).
    for (const token of [tA, tB, coach, student]) expect(await status(makePrimary(lb, token))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(http().post(`${ASSIGN}/${lb}/primary`))).toEqual([401, 'UNAUTHORIZED']);

    const res = await makePrimary(lb).expect(200);
    expect(res.body).toMatchObject({ id: lb, role: 'PRIMARY', teacher: { id: b }, school: { id: s } });
    expect((await linksOf(s)).map((l) => [l.teacherId, l.role])).toEqual([[a, 'SECONDARY'], [b, 'PRIMARY']]);
    expect(await p().auditLog.findFirstOrThrow({ where: { action: 'TEACHER_PRIMARY_ASSIGNED', entityId: lb } })).toMatchObject({
      actorId: ctx.ids.admin, entity: 'TeacherSchoolAssignment',
      metadata: { schoolId: s, teacherId: b, previousAssignmentId: la, previousTeacherId: a },
    });
    expect(await status(makePrimary(lb))).toEqual([409, 'ALREADY_PRIMARY']);
    expect(await status(makePrimary('00000000-0000-4000-8000-000000000000'))).toEqual([404, 'NOT_FOUND']);
    // Back again, and two concurrent reassignments: still exactly one primary.
    await makePrimary(la).expect(200);
    const c = await teacher('pt.r3');
    const lc = (await assign(c, s).expect(201)).body.id;
    const both = await Promise.all([makePrimary(lb), makePrimary(lc)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 200]);
    expect(await primaryOf(s)).toHaveLength(1);
    // A school without any primary: the chosen teacher becomes primary, nobody is demoted (previous: null).
    const s2 = await school('gs primary none yet');
    const d = await teacher('pt.r4');
    const e = await teacher('pt.r5');
    const ld = (await assign(d, s2).expect(201)).body.id;
    const le = (await assign(e, s2).expect(201)).body.id;
    await http().delete(`${ASSIGN}/${ld}`).set(bearer(admin)).expect(200);
    expect(await primaryOf(s2)).toEqual([]);
    await makePrimary(le).expect(200);
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'TEACHER_PRIMARY_ASSIGNED', entityId: le } })).metadata)
      .toMatchObject({ previousAssignmentId: null, previousTeacherId: null });
    // An ended link cannot be made primary.
    expect(await status(makePrimary(ld))).toEqual([409, 'ASSIGNMENT_ENDED']);
  });

  it('ending the primary\'s link leaves the school WITHOUT a primary: secondaries stay secondary; a newly assigned teacher then becomes primary', async () => {
    const s = await school('gs primary ended');
    const [a, b, c] = await Promise.all(['pt.e1', 'pt.e2', 'pt.e3'].map(teacher));
    const la = (await assign(a, s).expect(201)).body.id;
    await assign(b, s).expect(201);
    const ended = await http().delete(`${ASSIGN}/${la}`).set(bearer(admin)).expect(200);
    expect(ended.body).toMatchObject({ isActive: false, role: 'SECONDARY' });
    expect(await primaryOf(s)).toEqual([]);
    expect((await linksOf(s)).map((l) => [l.teacherId, l.isActive, l.role])).toEqual([[a, false, 'SECONDARY'], [b, true, 'SECONDARY']]);
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'UNASSIGN_TEACHER_SCHOOL', entityId: la } })).metadata).toMatchObject({ wasPrimary: true });
    // The Teachers tab's "no primary teacher" state.
    expect((await http().get(ASSIGN).query({ schoolId: s, isActive: true, role: 'PRIMARY' }).set(bearer(admin)).expect(200)).body.meta.total).toBe(0);
    // A teacher an Administrator assigns now becomes primary (the school has none); the waiting secondary is not promoted.
    expect((await assign(c, s).expect(201)).body.role).toBe('PRIMARY');
    expect(await primaryOf(s)).toEqual([c]);
  });

  it('an account that leaves ACTIVE is no school\'s primary (cleared, audited, never restored or promoted); a role change ends its links', async () => {
    const s = await school('gs primary suspended');
    const s2 = await school('gs primary suspended 2');
    const [a, b] = await Promise.all(['pt.s1', 'pt.s2'].map(teacher));
    await assign(a, s).expect(201);
    await assign(a, s2).expect(201);
    await assign(b, s).expect(201);
    const setStatus = (id: string, toStatus: string) => http().post(`/api/v1/admin/users/${id}/status-changes`).set(bearer(admin))
      .send({ toStatus, reason: 'Primary teacher check', ...(toStatus === 'ACTIVE' && { confirm: true }) });
    await setStatus(a, 'SUSPENDED').expect((r) => { if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); });
    expect(await primaryOf(s)).toEqual([]);
    expect(await primaryOf(s2)).toEqual([]);
    // The links stay (the teacher keeps the schools), as SECONDARY; the secondary teacher is not promoted.
    expect((await linksOf(s)).map((l) => [l.teacherId, l.isActive, l.role])).toEqual([[a, true, 'SECONDARY'], [b, true, 'SECONDARY']]);
    const cleared = await p().auditLog.findMany({ where: { action: 'TEACHER_PRIMARY_CLEARED', metadata: { path: ['teacherId'], equals: a } } });
    expect(cleared.map((x) => (x.metadata as any).schoolId).sort()).toEqual([s, s2].sort());
    expect(cleared[0].metadata).toMatchObject({ reason: 'ACCOUNT_STATUS', toStatus: 'SUSPENDED' });
    // A suspended teacher cannot be made primary, nor become primary through a new assignment.
    const linkA = (await linksOf(s)).find((l) => l.teacherId === a)!.id;
    expect(await status(makePrimary(linkA))).toEqual([409, 'TEACHER_ACCOUNT_NOT_ACTIVE']);
    const s3 = await school('gs primary suspended 3');
    expect((await assign(a, s3).expect(201)).body.role).toBe('SECONDARY');
    // Reactivated: still SECONDARY everywhere (an Administrator chooses the primary again).
    await setStatus(a, 'ACTIVE').expect((r) => { if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); });
    expect(await primaryOf(s)).toEqual([]);
    await makePrimary(linkA).expect(200);
    expect(await primaryOf(s)).toEqual([a]);

    // Deactivated and archived accounts too.
    for (const toStatus of ['DEACTIVATED', 'ARCHIVED']) {
      const sx = await school(`gs primary ${toStatus.toLowerCase()}`);
      const t = await teacher(`pt.${toStatus.toLowerCase()}`);
      await assign(t, sx).expect(201);
      await setStatus(t, toStatus).expect((r) => { if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`); });
      expect(await primaryOf(sx)).toEqual([]);
    }

    // A role change ends every link (existing rule): the school has no primary.
    const s4 = await school('gs primary role change');
    const r = await teacher('pt.role');
    await assign(r, s4).expect(201);
    await http().patch(`/api/v1/admin/users/${r}`).set(bearer(admin)).send({ role: 'MENTOR', currentPassword: PASSWORD }).expect(200);
    expect(await primaryOf(s4)).toEqual([]);
    expect((await linksOf(s4))[0]).toMatchObject({ isActive: false, role: 'SECONDARY' });
  });

  it('the Users list shows a teacher\'s school: the primary one, else the earliest secondary; ended links never; plus how many (owner 2026-11-22)', async () => {
    const [s1, s2, s3] = [await school('gs list one'), await school('gs list two'), await school('gs list three')];
    const [first, other] = await Promise.all(['pt.l1', 'pt.l2'].map(teacher));
    await assign(first, s1).expect(201);                      // PRIMARY of s1
    await assign(other, s1).expect(201);                      // SECONDARY of s1 (earliest link of `other`)
    const ofOther = await assign(other, s2).expect(201);      // PRIMARY of s2, created later: still wins
    expect(ofOther.body.role).toBe('PRIMARY');
    const lone = await teacher('pt.l3');
    await assign(lone, s3).expect(201);
    await p().teacherSchoolAssignment.updateMany({ where: { teacherId: lone }, data: { isActive: false, endedAt: new Date() } });
    const none = await teacher('pt.l4');

    const rows = (await http().get('/api/v1/admin/users').query({ role: 'TEACHER', search: 'pt.l', limit: 50 }).set(bearer(admin)).expect(200)).body.data;
    const row = (id: string) => rows.find((u: any) => u.id === id);
    expect(row(first)).toMatchObject({ school: { id: s1, name: 'gs list one' }, schoolCount: 1 });
    expect(row(other)).toMatchObject({ school: { id: s2, name: 'gs list two' }, schoolCount: 2 });
    expect(row(lone)).toMatchObject({ school: null, schoolCount: 0 });
    expect(row(none)).toMatchObject({ school: null, schoolCount: 0 });
    // Students keep their own school field; only TEACHER rows carry schoolCount.
    const students = (await http().get('/api/v1/admin/users').query({ role: 'STUDENT', limit: 5 }).set(bearer(admin)).expect(200)).body.data;
    expect(students.length).toBeGreaterThan(0);
    for (const u of students) { expect(u).toHaveProperty('school'); expect(u).not.toHaveProperty('schoolCount'); }
  });

  it('the role is shown everywhere it applies: School Access, the Users list, the teacher\'s own schools — with the same rights', async () => {
    const s = await school('gs primary views');
    const [a, b] = await Promise.all(['pt.v1', 'pt.v2'].map(teacher));
    const none = await teacher('pt.v3');
    await assign(a, s).expect(201);
    await assign(b, s).expect(201);
    const access = (await http().get(`/api/v1/admin/schools/${s}/access`).set(bearer(admin)).expect(200)).body;
    expect(access.teachers.map((t: any) => [t.teacher.id, t.role]).sort()).toEqual([[a, 'PRIMARY'], [b, 'SECONDARY']].sort());

    const users = (await http().get('/api/v1/admin/users').query({ role: 'TEACHER', search: 'pt.v', limit: 50 }).set(bearer(admin)).expect(200)).body.data;
    const roleOf = (id: string) => users.find((u: any) => u.id === id)?.teacherSchoolRole;
    expect([roleOf(a), roleOf(b), roleOf(none)]).toEqual(['PRIMARY', 'SECONDARY', null]);
    // Only TEACHER rows carry it.
    const students = (await http().get('/api/v1/admin/users').query({ role: 'STUDENT', limit: 5 }).set(bearer(admin)).expect(200)).body.data;
    for (const u of students) expect(u).not.toHaveProperty('teacherSchoolRole');

    const [tA, tB] = await Promise.all([login(ctx, 'pt.v1'), login(ctx, 'pt.v2')]);
    const mine = (await http().get('/api/v1/teacher/schools').set(bearer(tA)).expect(200)).body;
    expect(mine).toEqual([expect.objectContaining({ role: 'PRIMARY', school: expect.objectContaining({ id: s, name: 'gs primary views', district: 'Huye', sector: 'Ngoma' }) })]);
    expect(Object.keys(mine[0]).sort()).toEqual(['assignmentId', 'role', 'school', 'since']);
    expect((await http().get('/api/v1/teacher/schools').set(bearer(tB)).expect(200)).body.map((x: any) => x.role)).toEqual(['SECONDARY']);
    expect((await http().get('/api/v1/teacher/schools').set(bearer(await login(ctx, 'pt.v3'))).expect(200)).body).toEqual([]);
    // Other roles: refused (the route is the teacher's own data).
    expect(await status(http().get('/api/v1/teacher/schools').set(bearer(admin)))).toEqual([403, 'ROLE_NOT_SUPPORTED']);
    for (const token of [coach, student]) expect((await http().get('/api/v1/teacher/schools').set(bearer(token))).status).toBe(403);

    // The same rights: identical effective permissions and the same student list for both teachers.
    const perms = async (token: string) => (await http().get('/api/v1/me/permissions').set(bearer(token)).expect(200)).body.permissions;
    expect(await perms(tA)).toEqual(await perms(tB));
    const list = async (token: string) => (await http().get('/api/v1/teacher/students').set(bearer(token)).expect(200)).body.meta.total;
    expect(await list(tA)).toBe(await list(tB));
  });
});
