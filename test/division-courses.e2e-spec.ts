/**
 * The courses each division offers, and a coach on many course x division pairs at once (owner 2026-11-22), end to end:
 *  - every course is offered in every division at first; an Administrator chooses a division's courses (audited); a new
 *    course is offered in every active division; a new division offers nothing until chosen;
 *  - a student sees, and opens, only the published courses their division offers (a course not offered: 404);
 *  - one coach assignment only to an offered pair (400 COURSE_NOT_OFFERED);
 *  - bulk: ALL offered pairs, every course one division offers, or chosen pairs; a preview (NEW / REACTIVATE /
 *    ALREADY_ASSIGNED) that changes nothing; never a duplicate; an ended assignment is reactivated; pairs not offered are
 *    reported, never assigned; audited per change;
 *  - Head Coaches: only the programmes they head, for a Coach of them; never themselves or another Head Coach;
 *  - only holders of the permissions (never a coach or a student).
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Division courses and bulk coach assignment (e2e)', () => {
  let ctx: TestContext;
  let admin: string, coach: string, student: string, hc: string;
  let middle: string, courses: Record<string, string>, maths: string;
  let hash: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const C = (id: string) => `/api/v1/admin/divisions/${id}/courses`;
  const BULK = '/api/v1/admin/mentor-assignments/bulk';
  const offered = async (divisionId: string) => (await http().get(C(divisionId)).set(bearer(admin)).expect(200)).body
    .filter((c: any) => c.offered).map((c: any) => c.code).sort();
  const assignments = (mentorId: string) => p().mentorAssignment.findMany({ where: { mentorId, isActive: true }, include: { course: true, division: true } })
    .then((rows) => rows.map((r) => `${r.course.code}/${r.division.code}`).sort());

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    middle = (await p().division.findUniqueOrThrow({ where: { code: 'MIDDLE' } })).id;
    courses = Object.fromEntries((await p().course.findMany()).map((c) => [c.code, c.id]));
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    // A Middle student.
    const s = await p().user.create({ data: {
      username: 'dc.middle', firstName: 'Mid', lastName: 'Student', email: 'dc.middle@test.local', role: 'STUDENT', passwordHash: hash,
      activatedAt: new Date(), gradeLevel: 'S3', divisionId: ctx.ids.junior, dateOfBirth: new Date('2011-01-01'),
    } });
    await p().$executeRaw`SELECT set_config('rof.division_change', 'recorded', false)`;
    await p().user.update({ where: { id: s.id }, data: { divisionId: middle, divisionManual: true } });
    await p().$executeRaw`SELECT set_config('rof.division_change', '', false)`;
    student = await login(ctx, 'dc.middle');
    // A Head Coach of Mathematics; mentor.j belongs to Mathematics.
    const hcId = (await p().user.create({ data: { username: 'dc.hc', firstName: 'H', lastName: 'C', email: 'dc.hc@test.local', role: 'HEAD_COACH', passwordHash: hash, activatedAt: new Date() } })).id;
    await p().programmeMembership.create({ data: { userId: hcId, disciplineId: maths, source: 'MANUAL' } });
    if (!(await p().programmeMembership.findFirst({ where: { userId: ctx.ids.mentorJunior2, disciplineId: maths, isActive: true } }))) {
      await p().programmeMembership.create({ data: { userId: ctx.ids.mentorJunior2, disciplineId: maths, source: 'MANUAL' } });
    }
    hc = await login(ctx, 'dc.hc');
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('at first every course is offered in every division', async () => {
    for (const d of [ctx.ids.junior, middle, ctx.ids.senior]) expect(await offered(d)).toEqual(['ALGEBRA', 'COMBINATORICS', 'GEOMETRY', 'NUMBER_THEORY']);
  });

  it('an Administrator chooses Middle\'s courses (audited): Middle students see and open only those; other divisions unchanged', async () => {
    const r = (await http().put(C(middle)).set(bearer(admin)).send({ courseIds: [courses.ALGEBRA, courses.GEOMETRY] }).expect(200)).body;
    expect(r.filter((c: any) => c.offered).map((c: any) => c.code).sort()).toEqual(['ALGEBRA', 'GEOMETRY']);
    expect((await p().auditLog.findFirstOrThrow({ where: { action: 'DIVISION_COURSES_SET', entityId: middle } })).metadata)
      .toMatchObject({ code: 'MIDDLE', added: [], removed: expect.arrayContaining([courses.NUMBER_THEORY, courses.COMBINATORICS]) });
    expect(await offered(ctx.ids.junior)).toEqual(['ALGEBRA', 'COMBINATORICS', 'GEOMETRY', 'NUMBER_THEORY']);
    const mine = (await http().get('/api/v1/courses').set(bearer(student)).expect(200)).body;
    expect(mine.map((c: any) => c.code).sort()).toEqual(['ALGEBRA', 'GEOMETRY']);
    await http().get(`/api/v1/courses/${courses.ALGEBRA}`).set(bearer(student)).expect(200);
    await http().get(`/api/v1/courses/${courses.NUMBER_THEORY}`).set(bearer(student)).expect(404);
    // A Junior student still sees all four.
    const junior = (await http().get('/api/v1/courses').set(bearer(await login(ctx, 'student.j'))).expect(200)).body;
    expect(junior).toHaveLength(4);
    // Unknown courses are refused; nothing changed.
    expect(await status(http().put(C(middle)).set(bearer(admin)).send({ courseIds: ['00000000-0000-4000-8000-000000000000'] }))).toEqual([400, 'UNKNOWN_COURSE']);
    expect(await offered(middle)).toEqual(['ALGEBRA', 'GEOMETRY']);
  });

  it('a new course (seed or script) is offered in every active division; a new division offers nothing until chosen', async () => {
    // Courses are created by the seed or a script (no API route): the database offers them everywhere.
    const id = (await p().course.create({ data: { code: 'INEQUALITIES', title: 'Inequalities', description: 'Classic inequalities', disciplineId: maths, status: 'PUBLISHED', publishedAt: new Date(), sortOrder: 9 } })).id;
    for (const d of [ctx.ids.junior, middle, ctx.ids.senior]) expect(await offered(d)).toContain('INEQUALITIES');
    const adv = (await http().post('/api/v1/admin/divisions').set(bearer(admin)).send({ code: 'ADVANCED', name: 'Advanced', sortOrder: 4 }).expect(201)).body;
    expect(await offered(adv.id)).toEqual([]);
    await http().put(C(middle)).set(bearer(admin)).send({ courseIds: [courses.ALGEBRA, courses.GEOMETRY] }).expect(200);   // Middle: 2 again
    courses.INEQUALITIES = id;
  });

  it('one assignment only to an offered pair', async () => {
    expect(await status(http().post('/api/v1/admin/mentor-assignments').set(bearer(admin))
      .send({ mentorId: ctx.ids.mentorJunior, courseId: courses.NUMBER_THEORY, divisionId: middle }))).toEqual([400, 'COURSE_NOT_OFFERED']);
  });

  it('bulk "all Middle courses": the preview changes nothing; applied once; again: nothing new, never a duplicate', async () => {
    const body = { mentorId: ctx.ids.mentorJunior2, scope: 'DIVISION', divisionId: middle };
    const preview = (await http().post(BULK).set(bearer(admin)).send({ ...body, dryRun: true }).expect(201)).body;
    expect(preview).toMatchObject({ applied: false, counts: { total: 2, new: 2, reactivate: 0, alreadyAssigned: 0, notOffered: 0 } });
    expect(preview.pairs.map((x: any) => `${x.course.code}/${x.division.code}/${x.state}`)).toEqual(['ALGEBRA/MIDDLE/NEW', 'GEOMETRY/MIDDLE/NEW']);
    expect(await assignments(ctx.ids.mentorJunior2)).toEqual(['ALGEBRA/JUNIOR']);
    const done = (await http().post(BULK).set(bearer(admin)).send(body).expect(201)).body;
    expect(done).toMatchObject({ applied: true, counts: { new: 2 } });
    expect(await assignments(ctx.ids.mentorJunior2)).toEqual(['ALGEBRA/JUNIOR', 'ALGEBRA/MIDDLE', 'GEOMETRY/MIDDLE']);
    const again = (await http().post(BULK).set(bearer(admin)).send(body).expect(201)).body;
    expect(again.counts).toMatchObject({ total: 2, new: 0, alreadyAssigned: 2 });
    expect(await p().mentorAssignment.count({ where: { mentorId: ctx.ids.mentorJunior2 } })).toBe(3);
    expect(await p().auditLog.count({ where: { action: 'ASSIGN_MENTOR', actorId: ctx.ids.admin, metadata: { path: ['bulk'], equals: 'DIVISION' } } })).toBe(2);
  });

  it('bulk "all courses": every offered pair (the division choices respected), the existing one kept; an ended one reactivated', async () => {
    const ended = await p().mentorAssignment.findFirstOrThrow({ where: { mentorId: ctx.ids.mentorSenior } });
    await http().delete(`/api/v1/admin/mentor-assignments/${ended.id}`).set(bearer(admin)).expect(200);
    const preview = (await http().post(BULK).set(bearer(admin)).send({ mentorId: ctx.ids.mentorSenior, scope: 'ALL', dryRun: true }).expect(201)).body;
    // Junior 5 + Middle 2 + Senior 5 (ADVANCED offers nothing).
    expect(preview.counts).toMatchObject({ total: 12, reactivate: 1, alreadyAssigned: 0, new: 11 });
    expect(preview.pairs.find((x: any) => x.course.code === 'ALGEBRA' && x.division.code === 'SENIOR').state).toBe('REACTIVATE');
    expect(preview.pairs.some((x: any) => x.division.code === 'MIDDLE' && x.course.code === 'NUMBER_THEORY')).toBe(false);
    await http().post(BULK).set(bearer(admin)).send({ mentorId: ctx.ids.mentorSenior, scope: 'ALL' }).expect(201);
    expect(await assignments(ctx.ids.mentorSenior)).toHaveLength(12);
    expect(await p().mentorAssignment.count({ where: { mentorId: ctx.ids.mentorSenior } })).toBe(12);   // reactivated, not duplicated
  });

  it('bulk chosen pairs: offered ones assigned, others reported and never assigned', async () => {
    const r = (await http().post(BULK).set(bearer(admin)).send({
      mentorId: ctx.ids.mentorJunior, scope: 'PAIRS',
      pairs: [{ courseId: courses.GEOMETRY, divisionId: middle }, { courseId: courses.NUMBER_THEORY, divisionId: middle }],
    }).expect(201)).body;
    expect(r.counts).toMatchObject({ total: 1, new: 1, notOffered: 1 });
    expect(r.notOffered).toEqual([{ courseId: courses.NUMBER_THEORY, divisionId: middle }]);
    expect(await assignments(ctx.ids.mentorJunior)).toEqual(['ALGEBRA/JUNIOR', 'GEOMETRY/MIDDLE']);
    expect(await status(http().post(BULK).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior, scope: 'PAIRS', pairs: [] }))).toEqual([400, 'VALIDATION_FAILED']);
    expect(await status(http().post(BULK).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior, scope: 'DIVISION' }))).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('Head Coaches: only for a Coach of a programme they head, never themselves; only Administrators and Head Coaches (never a coach or a student)', async () => {
    const r = (await http().post(BULK).set(bearer(hc)).send({ mentorId: ctx.ids.mentorJunior2, scope: 'DIVISION', divisionId: ctx.ids.senior, dryRun: true }).expect(201)).body;
    expect(r.counts.total).toBe(5);   // Mathematics courses offered in Senior
    expect(await status(http().post(BULK).set(bearer(hc)).send({ mentorId: (await p().user.findUniqueOrThrow({ where: { username: 'dc.hc' } })).id, scope: 'ALL', dryRun: true })))
      .toEqual([403, 'SCOPE_FORBIDDEN']);
    // A coach who is not a member of Mathematics: nothing in the Head Coach's reach.
    const outsider = (await p().user.create({ data: { username: 'dc.outsider', firstName: 'O', lastName: 'C', email: 'dc.outsider@test.local', role: 'MENTOR', passwordHash: hash, activatedAt: new Date() } })).id;
    expect((await http().post(BULK).set(bearer(hc)).send({ mentorId: outsider, scope: 'ALL', dryRun: true }).expect(201)).body.counts.total).toBe(0);
    // An Administrator may give that coach any offered pair.
    expect((await http().post(BULK).set(bearer(admin)).send({ mentorId: outsider, scope: 'ALL', dryRun: true }).expect(201)).body.counts.total).toBe(12);
    for (const token of [coach, student]) {
      expect((await http().post(BULK).set(bearer(token)).send({ mentorId: ctx.ids.mentorJunior2, scope: 'ALL', dryRun: true })).status).toBe(403);
      expect((await http().put(C(middle)).set(bearer(token)).send({ courseIds: [] })).status).toBe(403);
    }
    expect((await http().put(C(middle)).set(bearer(hc)).send({ courseIds: [] })).status).toBe(403);   // divisions are Administrators'
    expect(await offered(middle)).toEqual(['ALGEBRA', 'GEOMETRY']);
  });
});
