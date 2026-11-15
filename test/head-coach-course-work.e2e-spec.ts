/**
 * P1-10 part 2 — H4: a Head Coach prepares and grades work only through a course ×
 * division assignment created by an Administrator, and receives grading work only
 * through the normal distribution (plan §5, §7.4, §11.2).
 *
 * Fixtures: Mathematics (seed) + test-only Physics; HM heads Maths, HP heads Physics.
 */
import { createTestApp, login, bearer, inDays, PDF, type TestContext } from './helpers.js';

describe('Head Coach course work (P1-10 H4)', () => {
  let ctx: TestContext;
  let admin: string, hm: string, hp: string, studentJ: string, coachJ: string;
  let maths: string, mechanics: string, hmId: string, hpId: string;
  let hmAssignmentId: string, workId: string, subId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const ASSIGN = '/api/v1/admin/mentor-assignments';
  const scope = (mentorId: string, courseId = ctx.ids.algebra, divisionId = ctx.ids.junior) => ({ mentorId, courseId, divisionId });
  const draft = (token: string, divisionId = ctx.ids.junior, title = 'HC linear equations') => {
    const req = http().post('/api/v1/assignments').set(bearer(token));
    const fields = {
      title, courseId: ctx.ids.algebra, divisionId, instructions: 'Solve every equation and show each step.',
      deadline: inDays(7), points: '10', maximumMarks: '10',
    };
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req;
  };

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    studentJ = await login(ctx, 'student.j');
    coachJ = await login(ctx, 'mentor.j');
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    const physics = (await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics' } })).id;
    mechanics = (await p().course.create({ data: {
      code: 'MECHANICS', disciplineId: physics, title: 'Mechanics', description: 'Physics course', status: 'PUBLISHED', publishedAt: new Date(),
    } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string) => (await p().user.create({ data: {
      username, firstName: username, lastName: 'Test', email: `${username}@test.local`, role: 'HEAD_COACH', passwordHash: hash, activatedAt: new Date(),
    } })).id;
    hmId = await mk('h4.maths');
    hpId = await mk('h4.phys');
    await http().put(`/api/v1/admin/programmes/${maths}/heads`).set(bearer(admin)).send({ userIds: [hmId] }).expect(200);
    await http().put(`/api/v1/admin/programmes/${physics}/heads`).set(bearer(admin)).send({ userIds: [hpId] }).expect(200);
    hm = await login(ctx, 'h4.maths');
    hp = await login(ctx, 'h4.phys');
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('without an assignment a Head Coach can neither prepare nor review work, and sees no teaching scope', async () => {
    expect(await status(draft(hm))).toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);
    expect((await http().get('/api/v1/me/teaching').set(bearer(hm)).expect(200)).body).toEqual([]);
    expect((await http().get('/api/v1/mentor/reviews').set(bearer(hm)).expect(200)).body.data).toEqual([]);
    expect(await p().assignment.count({ where: { createdById: hmId } })).toBe(0);
  });

  it('only an Administrator creates a Head Coach assignment, and only on a course of a programme the Head Coach heads', async () => {
    // Head Coaches never assign themselves or another Head Coach (P1-10 part 1).
    expect(await status(http().post(ASSIGN).set(bearer(hm)).send(scope(hmId)))).toEqual([403, 'SCOPE_FORBIDDEN']);
    expect(await status(http().post(ASSIGN).set(bearer(hp)).send(scope(hmId, mechanics)))).toEqual([403, 'SCOPE_FORBIDDEN']);
    // Administrator, outside the Head Coach's programme: refused.
    expect(await status(http().post(ASSIGN).set(bearer(admin)).send(scope(hmId, mechanics)))).toEqual([400, 'NOT_PROGRAMME_HEAD']);
    expect(await status(http().post(ASSIGN).set(bearer(admin)).send(scope(hpId)))).toEqual([400, 'NOT_PROGRAMME_HEAD']);
    expect(await p().mentorAssignment.count({ where: { mentorId: { in: [hmId, hpId] } } })).toBe(0);

    const created = await http().post(ASSIGN).set(bearer(admin)).send(scope(hmId)).expect(201);
    hmAssignmentId = created.body.id;
    expect(created.body).toMatchObject({ isActive: true, mentor: { id: hmId }, assignedBy: { id: ctx.ids.admin } });
    expect(await p().auditLog.findFirstOrThrow({ where: { action: 'ASSIGN_MENTOR', entityId: hmAssignmentId } }))
      .toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN' });

    const teaching = (await http().get('/api/v1/me/teaching').set(bearer(hm)).expect(200)).body;
    expect(teaching.map((t: any) => [t.course.id, t.division.id])).toEqual([[ctx.ids.algebra, ctx.ids.junior]]);
    expect((await http().get('/api/v1/me/permissions').set(bearer(hm)).expect(200)).body.scopes)
      .toEqual({ courseDivisions: [{ courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }], programmes: [maths] });
  });

  it('prepare: the assigned Head Coach drafts and submits work in that scope only; publishing stays with Administrators (audited)', async () => {
    expect(await status(draft(hm, ctx.ids.senior, 'HC out of scope'))).toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);
    expect(await status(draft(hp))).toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);

    const created = await draft(hm).expect(201);
    workId = created.body.id;
    expect(created.body).toMatchObject({ status: 'DRAFT', courseId: ctx.ids.algebra, divisionId: ctx.ids.junior });
    expect(await p().auditLog.findFirstOrThrow({ where: { action: 'CREATE_ASSIGNMENT', entityId: workId } }))
      .toMatchObject({ actorId: hmId, actorRole: 'HEAD_COACH' });

    // The Head Coach sees the draft (list, detail, history); HP and other scopes do not.
    const list = (await http().get('/api/v1/assignments').set(bearer(hm)).expect(200)).body.data.map((a: any) => a.id);
    expect(list).toContain(workId);
    await http().get(`/api/v1/assignments/${workId}`).set(bearer(hm)).expect(200);
    await http().get(`/api/v1/assignments/${workId}/history`).set(bearer(hm)).expect(200);
    expect((await http().get(`/api/v1/assignments/${workId}`).set(bearer(hp))).status).toBe(403);
    expect((await http().get('/api/v1/assignments').set(bearer(hp)).expect(200)).body.data).toEqual([]);

    await http().patch(`/api/v1/assignments/${workId}/submit`).set(bearer(hm)).expect(200);
    // H5: no approval or publication by a Head Coach.
    expect(await status(http().patch(`/api/v1/assignments/${workId}/publish`).set(bearer(hm)))).toEqual([403, 'PERMISSION_REQUIRED']);
    await http().patch(`/api/v1/assignments/${workId}/publish`).set(bearer(admin)).expect(200);
  });

  it('grade: work reaches the Head Coach only through the normal distribution; only they review it; Administrators approve and publish', async () => {
    subId = (await http().post('/api/v1/submissions').set(bearer(studentJ))
      .field('assignmentId', workId).attach('file', PDF, 'work.pdf').expect(201)).body.id;
    // Before distribution: nothing to grade.
    expect(await status(http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(hm)))).toEqual([403, 'NOT_ASSIGNED_MENTOR']);
    expect((await http().get(`/api/v1/submissions/${subId}`).set(bearer(hm))).status).toBe(404);

    // Normal distribution: HP (no assignment in the scope) is not eligible; HM is.
    expect(await status(http().post(`/api/v1/assignments/${workId}/distribute`).set(bearer(admin)).send({ mentorIds: [hpId] })))
      .toEqual([400, 'MENTOR_NOT_ELIGIBLE']);
    await http().post(`/api/v1/assignments/${workId}/distribute`).set(bearer(admin)).send({ mentorIds: [hmId] }).expect(200);
    const queue = (await http().get('/api/v1/mentor/reviews').set(bearer(hm)).expect(200)).body.data.map((s: any) => s.id);
    expect(queue).toEqual([subId]);

    // Only the assigned reviewer: the scope's coach and HP are refused.
    expect(await status(http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(coachJ)))).toEqual([403, 'NOT_ASSIGNED_MENTOR']);
    expect(await status(http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(hp)))).toEqual([403, 'NOT_ASSIGNED_MENTOR']);

    await http().patch(`/api/v1/submissions/${subId}/start-review`).set(bearer(hm)).expect(200);
    const marked = await http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(hm))
      .field('score', '8').field('mentorFeedback', 'Clear working; one sign error.').expect(200);
    expect(marked.body.review).toMatchObject({ score: 8 });
    await http().get(`/api/v1/submissions/${subId}/reviews`).set(bearer(hm)).expect(200);
    await http().patch(`/api/v1/submissions/${subId}/submit-to-admin`).set(bearer(hm)).expect(200);

    // H5: the Head Coach cannot approve or publish the result; Administrators still cannot grade (RS1).
    expect(await status(http().patch(`/api/v1/submissions/${subId}/approve`).set(bearer(hm)).send({}))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await status(http().patch(`/api/v1/submissions/${subId}/publish`).set(bearer(hm)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect((await http().patch(`/api/v1/submissions/${subId}/mark`).set(bearer(admin)).send({ score: 10, mentorFeedback: 'x' })).status).toBe(403);
    await http().patch(`/api/v1/submissions/${subId}/approve`).set(bearer(admin)).send({}).expect(200);
    await http().patch(`/api/v1/submissions/${subId}/publish`).set(bearer(admin)).expect(200);

    // Audit integrity: every grading step is recorded as the Head Coach.
    for (const action of ['START_REVIEW', 'MARK_SUBMISSION', 'RETURN_REVIEW_TO_ADMIN']) {
      expect([action, await p().auditLog.count({ where: { action, actorId: hmId, actorRole: 'HEAD_COACH' } })]).toEqual([action, 1]);
    }
    expect(await p().auditLog.count({ where: { action: 'DISTRIBUTE_SUBMISSIONS', actorId: ctx.ids.admin } })).toBe(1);
  });

  it('H6 and global boundaries hold for an assigned Head Coach: no resource management, distribution or reassignment', async () => {
    for (const make of [
      () => http().post(`/api/v1/courses/${ctx.ids.algebra}/resources`).field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'HC note'),
      () => http().post(`/api/v1/assignments/${workId}/distribute`).send({}),
      () => http().patch(`/api/v1/submissions/${subId}/reassign`).send({ mentorId: ctx.ids.mentorJunior }),
    ]) expect(await status(make().set(bearer(hm)))).toEqual([403, 'PERMISSION_REQUIRED']);
    expect(await p().courseResource.count({ where: { title: 'HC note' } })).toBe(0);
  });

  it('ending the assignment ends the Head Coach\'s course work on the next request; they are no longer eligible for distribution', async () => {
    await http().delete(`${ASSIGN}/${hmAssignmentId}`).set(bearer(admin)).expect(200);
    expect(await status(draft(hm, ctx.ids.junior, 'HC after unassign'))).toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);
    expect((await http().get(`/api/v1/assignments/${workId}`).set(bearer(hm))).status).toBe(403);
    expect(await status(http().post(`/api/v1/assignments/${workId}/distribute`).set(bearer(admin)).send({ mentorIds: [hmId] })))
      .toEqual([400, 'MENTOR_NOT_ELIGIBLE']);
    expect((await http().get('/api/v1/me/teaching').set(bearer(hm)).expect(200)).body).toEqual([]);
  });

  it('role changes: a coach promoted to Head Coach keeps none of their coach assignments; a demoted Head Coach keeps none either', async () => {
    const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
      firstName: 'H4', lastName: 'Coach', username: 'h4.coach', email: 'h4.coach@test.local', password: 'Str0ng!Passw0rd', role: 'MENTOR',
    }).expect(201);
    const coachId: string = created.body.id;
    await http().post(ASSIGN).set(bearer(admin)).send(scope(coachId)).expect(201);
    await http().patch(`/api/v1/admin/users/${coachId}`).set(bearer(admin)).send({ role: 'HEAD_COACH' }).expect(200);
    expect(await p().mentorAssignment.count({ where: { mentorId: coachId, isActive: true } })).toBe(0);
    const token = await login(ctx, 'h4.coach', 'Str0ng!Passw0rd');
    expect(await status(draft(token, ctx.ids.junior, 'Promoted coach work'))).toEqual([403, 'NOT_ASSIGNED_TO_SCOPE']);

    // A Head Coach with an Administrator-created assignment, demoted to coach: the assignment ends.
    await http().post(ASSIGN).set(bearer(admin)).send(scope(hmId)).expect(201);
    await http().patch(`/api/v1/admin/users/${hmId}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
    expect(await p().mentorAssignment.count({ where: { mentorId: hmId, isActive: true } })).toBe(0);
    expect(await p().auditLog.count({ where: { action: 'UNASSIGN_MENTOR', metadata: { path: ['mentorId'], equals: hmId } } })).toBe(1);
  });
});
