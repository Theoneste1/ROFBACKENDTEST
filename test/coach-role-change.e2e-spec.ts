/**
 * P1-05 — coach assignments when a coach changes role.
 *
 * A coach (MENTOR) whose role changes loses every course × division assignment
 * in the same transaction (rows kept as history, isActive = false, audited).
 * A MentorAssignment also never confers coach scope to a user who is not a
 * coach (defence in depth for rows left over from before this change).
 */
import { AccessService } from '../src/common/access/access.service.js';
import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';

describe('Coach role change → coach assignments (P1-05)', () => {
  let ctx: TestContext;
  let admin: string;
  const http = () => ctx.http();

  const assignmentsOf = (mentorId: string) =>
    ctx.prisma.mentorAssignment.findMany({
      where: { mentorId }, orderBy: { createdAt: 'asc' },
      select: { id: true, courseId: true, divisionId: true, isActive: true },
    });

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('changing a coach to another role deactivates all their assignments, keeps the rows, audits each one and ends sessions', async () => {
    const coachId = ctx.ids.mentorSenior;
    // Give the coach a second scope so "all" means more than one.
    await http().post('/api/v1/admin/mentor-assignments').set(bearer(admin))
      .send({ mentorId: coachId, courseId: ctx.ids.geometry, divisionId: ctx.ids.senior }).expect(201);
    const before = await assignmentsOf(coachId);
    expect(before.length).toBe(2);
    expect(before.every((a) => a.isActive)).toBe(true);
    const others = await ctx.prisma.mentorAssignment.findMany({ where: { mentorId: { not: coachId }, isActive: true }, select: { id: true } });

    const coachToken = await login(ctx, 'mentor.s');
    await http().get('/api/v1/me/teaching').set(bearer(coachToken)).expect(200);

    const res = await http().patch(`/api/v1/admin/users/${coachId}`).set(bearer(admin)).send({ role: 'ADMIN' }).expect(200);
    expect(res.body.role).toBe('ADMIN');

    // Rows kept, all inactive; nothing else touched.
    const after = await assignmentsOf(coachId);
    expect(after.map((a) => a.id)).toEqual(before.map((a) => a.id));
    expect(after.every((a) => !a.isActive)).toBe(true);
    const othersAfter = await ctx.prisma.mentorAssignment.findMany({ where: { id: { in: others.map((o) => o.id) } }, select: { isActive: true } });
    expect(othersAfter.every((o) => o.isActive)).toBe(true);

    // One UNASSIGN_MENTOR audit entry per assignment, with the reason; plus the role change.
    const audits = await ctx.prisma.auditLog.findMany({
      where: { action: 'UNASSIGN_MENTOR', entityId: { in: before.map((a) => a.id) } },
      select: { entityId: true, actorId: true, metadata: true },
    });
    expect(audits.map((a) => a.entityId).sort()).toEqual(before.map((a) => a.id).sort());
    for (const a of audits) {
      expect(a.actorId).toBe(ctx.ids.admin);
      expect(a.metadata).toMatchObject({ reason: 'ROLE_CHANGE', from: 'MENTOR', to: 'ADMIN', mentorId: coachId, openReviewsToReassign: 0 });
    }
    expect(await ctx.prisma.auditLog.count({ where: { action: 'CHANGE_USER_ROLE', entityId: coachId } })).toBe(1);

    // Sessions are ended: refresh tokens revoked and earlier access tokens invalidated.
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: coachId }, select: { tokensValidAfter: true } });
    expect(user.tokensValidAfter).not.toBeNull();
    expect(await ctx.prisma.refreshToken.count({ where: { userId: coachId, revokedAt: null } })).toBe(0);
    // The old coach token is refused outright (401) — on coach and on admin routes.
    await http().get('/api/v1/me/teaching').set(bearer(coachToken)).expect(401);
    await http().get('/api/v1/admin/users').set(bearer(coachToken)).expect(401);
  });

  it('security: a coach token issued just before promotion to ADMIN never works as an ADMIN token (same-second race)', async () => {
    // Repeated so the login and the role change fall in the same second at least
    // some of the time — the case whole-second iat comparison let through.
    for (let i = 0; i < 5; i++) {
      const username = `race.coach.${i}`;
      const created = await http().post('/api/v1/admin/users').set(bearer(admin)).send({
        firstName: 'Race', lastName: String(i), username, email: `${username}@test.local`, password: 'Str0ng!Passw0rd', role: 'MENTOR',
      }).expect(201);
      const coachToken = await login(ctx, username, 'Str0ng!Passw0rd');
      await http().patch(`/api/v1/admin/users/${created.body.id}`).set(bearer(admin)).send({ role: 'ADMIN' }).expect(200);

      // ADMIN-only endpoint: the old token must be rejected as a session, not merely forbidden.
      const res = await http().get('/api/v1/admin/users').set(bearer(coachToken));
      expect([i, res.status, res.body.code ?? null]).toEqual([i, 401, res.body.code ?? null]);

      // A fresh login right after the change works, with the new role.
      const fresh = await login(ctx, username, 'Str0ng!Passw0rd');
      await http().get('/api/v1/admin/users').set(bearer(fresh)).expect(200);
    }
  });

  it('a former coach (now a student) has no coach access and is not shown as a course coach', async () => {
    const coachId = ctx.ids.mentorJunior2;
    await http().patch(`/api/v1/admin/users/${coachId}`).set(bearer(admin)).send({ role: 'STUDENT', gradeLevel: 'S1' }).expect(200);
    expect((await assignmentsOf(coachId)).every((a) => !a.isActive)).toBe(true);

    const former = await login(ctx, 'mentor.j2');
    await http().get('/api/v1/me/teaching').set(bearer(former)).expect(403);
    const perms = await http().get('/api/v1/me/permissions').set(bearer(former)).expect(200);
    expect(perms.body.role).toBe('STUDENT');
    expect(perms.body.permissions).not.toContain('reviews.grade');

    // Admin course view and counts list only current coaches.
    const course = await http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(admin)).expect(200);
    const listed = course.body.mentorAssignments.map((m: any) => m.mentor.id);
    expect(listed).not.toContain(coachId);
    expect(listed).toContain(ctx.ids.mentorJunior);
  });

  it('a non-coach cannot be given coach assignments; changing back to coach does not revive old ones', async () => {
    const coachId = ctx.ids.mentorJunior2;   // a STUDENT since the previous test
    await http().post('/api/v1/admin/mentor-assignments').set(bearer(admin))
      .send({ mentorId: coachId, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior })
      .expect(400).expect((r) => expect(r.body.code).toBe('NOT_A_MENTOR'));

    await http().patch(`/api/v1/admin/users/${coachId}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
    const rows = await assignmentsOf(coachId);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((a) => !a.isActive)).toBe(true);
    const coach = await login(ctx, 'mentor.j2');
    expect((await http().get('/api/v1/me/teaching').set(bearer(coach)).expect(200)).body).toEqual([]);
    await http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(coach)).expect(403);

    // Explicit re-assignment re-activates the same row (history preserved, no duplicate).
    const again = await http().post('/api/v1/admin/mentor-assignments').set(bearer(admin))
      .send({ mentorId: coachId, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior }).expect(201);
    const rowsAfter = await assignmentsOf(coachId);
    expect(rowsAfter.length).toBe(rows.length);
    expect(rowsAfter.find((a) => a.id === again.body.id)?.isActive).toBe(true);
    const mine = await http().get('/api/v1/me/teaching').set(bearer(coach)).expect(200);
    expect(mine.body.map((m: any) => m.course.id)).toEqual([ctx.ids.algebra]);
  });

  it('updating a coach without changing the role keeps their assignments', async () => {
    const coachId = ctx.ids.mentorJunior;
    const before = await assignmentsOf(coachId);
    await http().patch(`/api/v1/admin/users/${coachId}`).set(bearer(admin)).send({ firstName: 'Renamed' }).expect(200);
    await http().patch(`/api/v1/admin/users/${coachId}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
    expect(await assignmentsOf(coachId)).toEqual(before);
    const coach = await login(ctx, 'mentor.j');
    await http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(coach)).expect(200);
  });

  it('a leftover active assignment of a non-coach (pre-existing data) confers nothing', async () => {
    // Simulate data written before this change: a non-coach with an ACTIVE assignment.
    const leftover = await ctx.prisma.user.create({
      data: {
        username: 'former.coach', firstName: 'Former', lastName: 'Coach', email: 'former.coach@test.local',
        role: 'ADMIN', activatedAt: new Date(), passwordHash: (await ctx.prisma.user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash,
      },
    });
    await ctx.prisma.mentorAssignment.create({
      data: { mentorId: leftover.id, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, isActive: true },
    });

    // Not listed as a course coach.
    const course = await http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(admin)).expect(200);
    expect(course.body.mentorAssignments.map((m: any) => m.mentor.id)).not.toContain(leftover.id);

    // Not notified as a coach of a new discussion in that scope; real coaches are.
    const student = await login(ctx, 'student.j');
    await http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(student))
      .send({ title: 'Role-change check', content: 'Who gets notified?' }).expect(201);
    await waitForEvents();
    const notified = async (userId: string) =>
      ctx.prisma.notification.count({ where: { userId, type: 'discussion.thread_created' } });
    expect(await notified(leftover.id)).toBe(0);
    expect(await notified(ctx.ids.mentorJunior)).toBeGreaterThan(0);

    // The scope helpers used for coach access and reviewer eligibility give it nothing.
    const access = ctx.app.get(AccessService);
    const scope = { courseId: ctx.ids.algebra, divisionId: ctx.ids.junior };
    expect(await access.isAssignedMentor(leftover.id, scope)).toBe(false);
    expect(await access.mentorScopes(leftover.id)).toEqual([]);
    expect(await access.isAssignedMentor(ctx.ids.mentorJunior, scope)).toBe(true);
  });
});
