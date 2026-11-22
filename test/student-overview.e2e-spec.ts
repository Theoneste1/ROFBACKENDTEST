/**
 * The Student Profile Overview (owner 2026-11-22), end to end: GET /students/:id/overview.
 *  - what it holds: photo, full name, username, country, school, grade, Olympiad level (division), Olympiad subjects;
 *    the account status for staff only; NEVER contact data, date of birth, guardian, home place or academic records;
 *  - who: the student; Administrators; other ACTIVE students; the Teachers of the student's school; the Coaches and
 *    Head Coaches of the student's programmes or taught divisions; anyone else 404 (as an unknown student); signed out 401;
 *  - a suspended student: hidden from other students; Administrators still see it; a non-student account: 404.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Student Profile Overview (e2e)', () => {
  let ctx: TestContext;
  let admin: string, student: string, classmate: string, coach: string, hcFar: string, teacherIn: string, teacherOut: string;
  let target: string, school: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const O = (id: string) => `/api/v1/students/${id}/overview`;

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    school = (await p().school.create({ data: { name: 'GS Overview', location: 'Huye', code: '250001', nameKey: 'gs overview', source: 'OFFICIAL_LIST', province: 'Southern Province', district: 'Huye', sector: 'Ngoma' } })).id;
    target = (await p().user.create({ data: {
      username: 'ov.target', firstName: 'Aline', lastName: 'Uwase', email: 'ov.target@test.local', role: 'STUDENT', passwordHash: hash, activatedAt: new Date(),
      gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: school, country: 'RW', phone: '+250788000111', guardianPhone: '+250788000222',
      dateOfBirth: new Date('2011-05-05'), homeLocation: 'Huye', olympiadInterests: ['MATHEMATICS', 'PHYSICS'], olympiadInterestOther: 'Chemistry',
    } })).id;
    await p().studentSchoolAffiliation.create({ data: { studentId: target, schoolId: school, status: 'VERIFIED', source: 'ADMIN', createdById: ctx.ids.admin, decidedById: ctx.ids.admin, decidedAt: new Date() } });
    const mk = async (username: string, role: 'TEACHER' | 'HEAD_COACH') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'X', email: `${username}@test.local`, role, passwordHash: hash, activatedAt: new Date() } })).id;
    const tIn = await mk('ov.tin', 'TEACHER');
    await mk('ov.tout', 'TEACHER');
    await mk('ov.hcfar', 'HEAD_COACH');
    await p().teacherSchoolAssignment.create({ data: { teacherId: tIn, schoolId: school, isActive: true, role: 'PRIMARY' } });
    [student, classmate, coach, hcFar, teacherIn, teacherOut] = await Promise.all(
      ['ov.target', 'student.j2', 'mentor.j', 'ov.hcfar', 'ov.tin', 'ov.tout'].map((u) => login(ctx, u)));
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('holds the basic identity only — never contact data, date of birth, guardian or home place', async () => {
    const body = (await http().get(O(target)).set(bearer(admin)).expect(200)).body;
    expect(body).toEqual({
      id: target, firstName: 'Aline', lastName: 'Uwase', username: 'ov.target', avatarUrl: null, country: 'RW',
      school: { id: school, name: 'GS Overview' }, gradeLevel: 'S2', olympiadLevel: { id: ctx.ids.junior, code: 'JUNIOR', name: 'Junior' },
      olympiadInterests: ['MATHEMATICS', 'PHYSICS'], olympiadInterestOther: 'Chemistry', accountStatus: 'ACTIVE',
    });
    const text = JSON.stringify(body);
    for (const secret of ['ov.target@test.local', '788000111', '788000222', '2011-05-05', 'Huye']) expect(text).not.toContain(secret);
  });

  it('the student, another student, the coach of the division and the school\'s teacher see it; students never see the account status', async () => {
    for (const token of [student, classmate]) {
      const b = (await http().get(O(target)).set(bearer(token)).expect(200)).body;
      expect(b).not.toHaveProperty('accountStatus');
      expect(b.olympiadLevel.code).toBe('JUNIOR');
    }
    for (const token of [coach, teacherIn]) expect((await http().get(O(target)).set(bearer(token)).expect(200)).body.accountStatus).toBe('ACTIVE');
  });

  it('anyone else: 404 (as an unknown student); signed out: 401; a non-student account: 404', async () => {
    const unknown = await http().get(O('00000000-0000-4000-8000-000000000000')).set(bearer(admin)).expect(404);
    for (const token of [hcFar, teacherOut]) expect((await http().get(O(target)).set(bearer(token)).expect(404)).body.message).toBe(unknown.body.message);
    await http().get(O(target)).expect(401);
    await http().get(O(ctx.ids.mentorJunior)).set(bearer(admin)).expect(404);
    await http().get('/api/v1/students/not-a-uuid/overview').set(bearer(admin)).expect(400);
  });

  it('a suspended student is hidden from other students; Administrators still see it', async () => {
    await p().user.update({ where: { id: target }, data: { accountStatus: 'SUSPENDED', isActive: false } });
    await http().get(O(target)).set(bearer(classmate)).expect(404);
    expect((await http().get(O(target)).set(bearer(admin)).expect(200)).body.accountStatus).toBe('SUSPENDED');
    await p().user.update({ where: { id: target }, data: { accountStatus: 'ACTIVE', isActive: true } });
    await http().get(O(target)).set(bearer(classmate)).expect(200);
  });
});
