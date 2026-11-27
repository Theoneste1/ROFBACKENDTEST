/**
 * A Coach edits no student profile data (owner 2026-11-27), end to end:
 *  - every route that changes a student — the account (name, username, e-mail, grade…), the date of birth, the picture,
 *    the account state, the registration data and the Olympiad level — refuses a Coach;
 *  - the Super Administrator cannot give a Coach a permission that would allow it (OVERRIDE_NOT_ALLOWED);
 *  - even a GRANT written straight into the database (outside the policy) unlocks nothing;
 *  - the student's row is unchanged afterwards;
 *  - a Coach still SEES the level of their programme's student, and a Head Coach and an Administrator still change it.
 */
import bcrypt from 'bcrypt';

import { bearer, createTestApp, login, type TestContext } from './helpers.js';

describe('A Coach edits no student profile data (e2e)', () => {
  let ctx: TestContext;
  let coach: string, admin: string, superAdmin: string, head: string;
  let student: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const status = async (r: PromiseLike<{ status: number; body: { code?: string } }>) => { const x = await r; return [x.status, x.body.code]; };
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

  beforeAll(async () => {
    ctx = await createTestApp();
    student = ctx.ids.studentJunior;
    const hash = await bcrypt.hash('Password123', 4);
    const maths = (await p().discipline.upsert({ where: { code: 'MATHEMATICS' }, create: { code: 'MATHEMATICS', name: 'Mathematics' }, update: {} })).id;   // test database only
    await p().user.create({ data: { username: 'cns.super', firstName: 'Sam', lastName: 'Super', email: 'cns.super@test.local', role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date() } });
    const h = await p().user.create({ data: { username: 'cns.head', firstName: 'Hana', lastName: 'Head', email: 'cns.head@test.local', role: 'HEAD_COACH', passwordHash: hash, activatedAt: new Date() } });
    // The coach, the head coach and the student share a programme: the coach may see the student.
    for (const userId of [ctx.ids.mentorJunior, h.id, student]) {
      await p().programmeMembership.upsert({ where: { userId_disciplineId: { userId, disciplineId: maths } }, update: { isActive: true, endedAt: null }, create: { userId, disciplineId: maths, source: 'MANUAL' } });
    }
    [coach, admin, superAdmin, head] = await Promise.all([
      login(ctx, 'mentor.j'), login(ctx, 'admin'), login(ctx, 'cns.super', 'Password123'), login(ctx, 'cns.head', 'Password123'),
    ]);
  });
  afterAll(async () => { await ctx?.app.close(); });

  const snapshot = () => p().user.findUniqueOrThrow({
    where: { id: student },
    select: { firstName: true, lastName: true, username: true, email: true, gradeLevel: true, dateOfBirth: true, avatarUrl: true, isActive: true, divisionId: true, divisionManual: true, phone: true },
  });

  /** Every route that changes a student, as the Coach. Each must be refused, and nothing may change. */
  async function everyStudentEdit(): Promise<(string | number | undefined)[][]> {
    const u = `/api/v1/admin/users/${student}`;
    const division = (await p().division.findFirstOrThrow({ where: { code: 'SENIOR' } })).id;
    return Promise.all([
      status(http().patch(u).set(bearer(coach)).send({ firstName: 'Changed', lastName: 'ByCoach' })),
      status(http().put(`${u}/date-of-birth`).set(bearer(coach)).send({ dateOfBirth: '2010-01-01', reason: 'Coach correction' })),
      status(http().put(`${u}/avatar`).set(bearer(coach)).attach('file', PNG, 'face.png')),
      status(http().delete(`${u}/avatar`).set(bearer(coach))),
      status(http().patch(`${u}/status`).set(bearer(coach)).send({ isActive: false })),
      status(http().post(`${u}/status-changes`).set(bearer(coach)).send({ status: 'SUSPENDED', reason: 'Coach suspends' })),
      status(http().delete(u).set(bearer(coach))),
      status(http().patch(`/api/v1/admin/registration-data/users/${student}`).set(bearer(coach)).send({ phone: '+250788000111' })),
      status(http().put(`/api/v1/admin/students/${student}/olympiad-level`).set(bearer(coach)).send({ divisionId: division, reason: 'Coach moves them' })),
      status(http().put(`/api/v1/admin/students/${student}/olympiad-level`).set(bearer(coach)).send({ automatic: true, reason: 'Coach resets it' })),
    ]);
  }

  it('by default: every student-editing route refuses the Coach, and the student is unchanged', async () => {
    const before = await snapshot();
    const answers = await everyStudentEdit();
    for (const [code] of answers) expect(code).toBe(403);
    expect(answers.at(-1)).toEqual([403, 'COACH_CANNOT_EDIT_STUDENTS']);
    expect(await snapshot()).toEqual(before);
  });

  it('the Super Administrator cannot give a Coach an editing permission', async () => {
    for (const permission of ['users.manage', 'users.manageStudents', 'registrationData.manage', 'students.classifyLevel', 'users.changeStatus']) {
      const [code, error] = await status(http().post(`/api/v1/admin/users/${ctx.ids.mentorJunior}/permission-overrides`).set(bearer(superAdmin))
        .send({ permission, effect: 'GRANT', reason: 'Trying to let a coach edit' }));
      expect([400]).toContain(code);
      expect(['OVERRIDE_NOT_ALLOWED', 'VALIDATION_FAILED']).toContain(error);
    }
    expect(await p().userPermissionOverride.count({ where: { userId: ctx.ids.mentorJunior, effect: 'GRANT' } })).toBe(0);
  });

  it('even GRANTs written straight into the database unlock nothing; the student is unchanged', async () => {
    for (const permission of ['users.manage', 'users.manageStudents', 'registrationData.manage', 'students.classifyLevel', 'users.changeStatus', 'users.suspend', 'users.archive']) {
      await p().userPermissionOverride.create({ data: { userId: ctx.ids.mentorJunior, permission, effect: 'GRANT', reason: 'Written outside the policy', createdById: ctx.ids.admin } });
    }
    coach = await login(ctx, 'mentor.j');
    const before = await snapshot();
    const answers = await everyStudentEdit();
    for (const [code] of answers) expect(code).toBe(403);
    expect(answers.at(-1)).toEqual([403, 'COACH_CANNOT_EDIT_STUDENTS']);
    expect(await snapshot()).toEqual(before);
    await p().userPermissionOverride.deleteMany({ where: { userId: ctx.ids.mentorJunior, effect: 'GRANT' } });
  });

  it('the Coach still SEES the level; a Head Coach and an Administrator still change it', async () => {
    const L = `/api/v1/admin/students/${student}/olympiad-level`;
    const view = await http().get(L).set(bearer(coach)).expect(200);
    expect(view.body.level).toBeTruthy();
    const senior = (await p().division.findFirstOrThrow({ where: { code: 'SENIOR' } })).id;
    expect((await http().put(L).set(bearer(head)).send({ divisionId: senior, reason: 'Strong results' }).expect(200)).body.level.code).toBe('SENIOR');
    expect((await http().put(L).set(bearer(admin)).send({ automatic: true, reason: 'Back to the grade' }).expect(200)).body.manual).toBe(false);
    // The Administrator still edits the account itself.
    await http().patch(`/api/v1/admin/users/${student}`).set(bearer(admin)).send({ firstName: 'Renamed' }).expect(200);
    expect((await snapshot()).firstName).toBe('Renamed');
  });

});
