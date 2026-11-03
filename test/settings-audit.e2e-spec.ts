/**
 * System settings (what administrators can configure, validation, that the
 * settings take effect, public support details) and the audit trail (what is
 * recorded, by whom, on which record; read-only, admin-only, append-only).
 */
import { AssignmentDeadlineReminderService } from '../src/assignments/assignment-deadline-reminder.service.js';
import { createTestApp, login, bearer, inDays, PDF, type TestContext, waitForEvents } from './helpers.js';

describe('System settings and audit logging (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, studentJ: string;

  const settings = (body: Record<string, unknown>, token = admin) =>
    ctx.http().patch('/api/v1/admin/settings').set(bearer(token)).send(body);
  const entries = (where: Record<string, unknown>) =>
    ctx.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, studentJ] = await Promise.all(['admin', 'mentor.j', 'student.j'].map((u) => login(ctx, u)));
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('system settings', () => {
    it('lists every setting by category with value, default, type and limits', async () => {
      const { body } = await ctx.http().get('/api/v1/admin/settings').set(bearer(admin)).expect(200);
      const byKey = Object.fromEntries(body.map((s: any) => [s.key, s]));
      expect(new Set(body.map((s: any) => s.category))).toEqual(
        new Set(['REGISTRATION', 'ASSIGNMENTS', 'NOTIFICATIONS', 'LIVE_SESSIONS', 'PLATFORM', 'SUPPORT']),
      );
      expect(byKey['assignments.defaultAllowResubmission']).toMatchObject({ value: false, default: false, type: 'boolean' });
      expect(byKey['notifications.deadlineReminderHours']).toMatchObject({ value: 24, type: 'integer', min: 1, max: 168, unit: 'hours' });
      expect(byKey['support.helpUrl']).toMatchObject({ value: null, type: 'url', nullable: true });
      expect(byKey['platform.name'].updatedBy).toBeNull();
    });

    it('only administrators can read or change settings', async () => {
      await ctx.http().get('/api/v1/admin/settings').set(bearer(mentorJ)).expect(403);
      await settings({ 'platform.name': 'Mine' }, mentorJ).expect(403);
      await settings({ 'platform.name': 'Mine' }, studentJ).expect(403);
    });

    it('rejects unknown keys, wrong types, out-of-range numbers and inconsistent combinations', async () => {
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ 'unknown.setting': true }, 'Unknown setting "unknown.setting".'],
        [{ 'notifications.deadlineReminderHours': 0 }, 'notifications.deadlineReminderHours must be at least 1.'],
        [{ 'notifications.deadlineReminderHours': 2.5 }, 'notifications.deadlineReminderHours must be a whole number.'],
        [{ 'liveSessions.maxDurationHours': 13 }, 'liveSessions.maxDurationHours must be at most 12.'],
        [{ 'platform.supportEmail': 'nobody' }, 'platform.supportEmail must be an e-mail address.'],
        [{ 'support.helpUrl': 'http://insecure.example' }, 'support.helpUrl must be an https:// link.'],
        [{ 'assignments.defaultMaxResubmissions': 3 }, 'assignments.defaultMaxResubmissions only applies when assignments.defaultAllowResubmission is true.'],
      ];
      for (const [body, message] of cases) {
        const res = await settings(body).expect(400);
        expect(res.body.code).toBe('INVALID_SETTINGS');
        expect(res.body.details).toContain(message);
      }
      await settings({}).expect(400);
      // Nothing was stored.
      expect(await ctx.prisma.systemSetting.count()).toBe(0);
    });

    it('records each changed setting in the audit log with its old and new value', async () => {
      const res = await settings({
        'platform.name': 'ROF Olympiad LMS', 'platform.supportEmail': 'help@rof.rw', 'leaderboard.visibleToStudents': true,
      }).expect(200);
      expect(res.body.find((s: any) => s.key === 'platform.name')).toMatchObject({
        value: 'ROF Olympiad LMS', updatedBy: expect.objectContaining({ username: 'admin' }),
      });

      const logged = await entries({ action: 'UPDATE_SETTING' });
      expect(logged.map((e) => [e.entityId, e.metadata])).toEqual([
        ['platform.name', { from: 'ROF Learning Platform', to: 'ROF Olympiad LMS' }],
        ['platform.supportEmail', { from: null, to: 'help@rof.rw' }],
      ]); // leaderboard.visibleToStudents did not change, so it is not logged
      expect(logged[0]).toMatchObject({ actorId: ctx.ids.admin, actorUsername: 'admin', actorRole: 'ADMIN', entity: 'SystemSetting' });
    });

    it('help and support details are public', async () => {
      await settings({
        'support.phone': '+250 788 000 000', 'support.hours': 'Mon–Fri, 08:00–17:00',
        'support.helpUrl': 'https://help.rof.rw', 'support.message': 'Ask your mentor first.',
      }).expect(200);
      const { body } = await ctx.http().get('/api/v1/support').expect(200);
      expect(body).toEqual({
        platformName: 'ROF Olympiad LMS', email: 'help@rof.rw', phone: '+250 788 000 000',
        hours: 'Mon–Fri, 08:00–17:00', helpUrl: 'https://help.rof.rw', message: 'Ask your mentor first.',
      });
      await settings({ 'support.message': null }).expect(200);
      expect((await ctx.http().get('/api/v1/support').expect(200)).body.message).toBeNull();
    });

    it('default resubmission rules apply to new assignments unless the mentor chooses', async () => {
      await settings({ 'assignments.defaultAllowResubmission': true, 'assignments.defaultMaxResubmissions': 2, 'assignments.defaultAllowLateSubmission': true }).expect(200);
      const create = (fields: Record<string, string> = {}) => {
        const req = ctx.http().post('/api/v1/assignments').set(bearer(mentorJ))
          .field('title', 'Defaults').field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
          .field('instructions', 'Solve every problem.').field('deadline', inDays(5)).field('points', '10').field('maximumMarks', '10');
        for (const [k, v] of Object.entries(fields)) req.field(k, v);
        return req.expect((r) => { if (r.status !== 201) throw new Error(JSON.stringify(r.body)); });
      };
      expect((await create()).body).toMatchObject({ allowResubmission: true, maxResubmissions: 2, allowLateSubmission: true });
      expect((await create({ allowResubmission: 'false', allowLateSubmission: 'false' })).body)
        .toMatchObject({ allowResubmission: false, maxResubmissions: 0, allowLateSubmission: false });
      await settings({ 'assignments.defaultAllowResubmission': false, 'assignments.defaultMaxResubmissions': 0, 'assignments.defaultAllowLateSubmission': false }).expect(200);
    });

    it('notification rules control the deadline reminders', async () => {
      await ctx.prisma.assignment.create({ data: {
        title: 'Due in 36 h', instructions: 'Solve.', deadline: new Date(inDays(1.5)), points: 10, maximumMarks: 10,
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
        createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
      } });
      const reminders = ctx.app.get(AssignmentDeadlineReminderService);
      expect(await reminders.sendDue()).toBe(0); // 24-hour window by default

      await settings({ 'notifications.deadlineRemindersEnabled': false, 'notifications.deadlineReminderHours': 48 }).expect(200);
      expect(await reminders.sendDue()).toBe(0); // switched off
      await settings({ 'notifications.deadlineRemindersEnabled': true }).expect(200);
      expect(await reminders.sendDue()).toBe(1); // within 48 hours
    });

    it('the live-session length limit is configurable', async () => {
      const schedule = (endHours: number) => ctx.http().post('/api/v1/live-sessions').set(bearer(mentorJ)).send({
        courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, title: 'Long workshop',
        startsAt: inDays(3), endsAt: new Date(Date.now() + 3 * 86_400_000 + endHours * 3_600_000).toISOString(),
        meetingUrl: 'https://zoom.us/j/1',
      });
      await settings({ 'liveSessions.maxDurationHours': 2 }).expect(200);
      const res = await schedule(3).expect(400);
      expect(res.body.message).toBe('A session cannot last longer than 2 hours.');
      await schedule(2).expect(201);
    });

    it('academic years are configured and the current one is visible', async () => {
      const current = await ctx.http().get('/api/v1/academic-years/current').set(bearer(studentJ)).expect(200);
      expect(current.body).toMatchObject({ id: ctx.ids.year, isCurrent: true });

      const next = await ctx.http().post('/api/v1/admin/academic-years').set(bearer(admin))
        .send({ name: '2027-2028', startsOn: '2027-09-01', endsOn: '2028-07-31' }).expect(201);
      await ctx.http().patch(`/api/v1/admin/academic-years/${next.body.id}`).set(bearer(admin)).send({ endsOn: '2028-07-15' }).expect(200);
      await ctx.http().post('/api/v1/admin/academic-years').set(bearer(mentorJ))
        .send({ name: '2028-2029', startsOn: '2028-09-01', endsOn: '2029-07-31' }).expect(403);

      const logged = await entries({ entity: 'AcademicYear', entityId: next.body.id });
      expect(logged.map((e) => e.action)).toEqual(['CREATE_ACADEMIC_YEAR', 'UPDATE_ACADEMIC_YEAR']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  describe('audit trail', () => {
    let newUserId: string;

    it('records user creation, role changes, enrolment changes and deactivation', async () => {
      const created = await ctx.http().post('/api/v1/admin/users').set(bearer(admin)).send({
        firstName: 'Ada', lastName: 'Audit', username: 'ada.audit', email: 'ada@test.local',
        password: 'Str0ng!Passw0rd', role: 'STUDENT', gradeLevel: 'S2',
      }).expect(201);
      newUserId = created.body.id;

      await ctx.http().patch(`/api/v1/admin/users/${newUserId}`).set(bearer(admin)).send({ gradeLevel: 'S5' }).expect(200);
      await ctx.http().patch(`/api/v1/admin/users/${newUserId}`).set(bearer(admin)).send({ role: 'MENTOR' }).expect(200);
      await ctx.http().patch(`/api/v1/admin/users/${newUserId}/status`).set(bearer(admin)).send({ isActive: false }).expect(200);

      const logged = await entries({ entityId: newUserId });
      expect(logged.map((e) => e.action)).toEqual([
        'CREATE_USER',
        'UPDATE_USER', 'CHANGE_STUDENT_ENROLLMENT',
        'UPDATE_USER', 'CHANGE_USER_ROLE', 'CHANGE_STUDENT_ENROLLMENT',
        'UPDATE_USER_STATUS',
      ]);
      const [, gradeUpdate, placed, , role, withdrawn, status] = logged;
      expect(gradeUpdate.metadata).toMatchObject({ changes: { gradeLevel: { from: 'S2', to: 'S5' }, divisionId: { from: ctx.ids.junior, to: ctx.ids.senior } } });
      expect(placed.metadata).toMatchObject({ change: 'PLACED', from: { gradeLevel: 'S2' }, to: { gradeLevel: 'S5', divisionId: ctx.ids.senior } });
      expect(role.metadata).toEqual({ from: 'STUDENT', to: 'MENTOR' });
      expect(withdrawn.metadata).toMatchObject({ change: 'WITHDRAWN' });
      expect(status.metadata).toMatchObject({ deactivated: true, changes: { isActive: { from: true, to: false } } });
      for (const e of logged) {
        expect(e).toMatchObject({ actorId: ctx.ids.admin, actorUsername: 'admin', actorRole: 'ADMIN', entity: 'User' });
        expect(e.createdAt).toBeInstanceOf(Date);
      }
      // Passwords never reach the audit log.
      expect(JSON.stringify(logged)).not.toContain('Str0ng');
    });

    it('records mentor assignments, assignment publication, distribution, grading, results and moderation', async () => {
      const scope = await ctx.http().post('/api/v1/admin/mentor-assignments').set(bearer(admin))
        .send({ mentorId: ctx.ids.mentorJunior, courseId: ctx.ids.geometry, divisionId: ctx.ids.junior }).expect(201);

      const draft = await ctx.http().post('/api/v1/assignments').set(bearer(mentorJ))
        .field('title', 'Audited').field('courseId', ctx.ids.algebra).field('divisionId', ctx.ids.junior)
        .field('instructions', 'Solve every problem.').field('deadline', inDays(5)).field('points', '10').field('maximumMarks', '10').expect(201);
      await ctx.http().patch(`/api/v1/assignments/${draft.body.id}/submit`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/assignments/${draft.body.id}/publish`).set(bearer(admin)).expect(200);

      const sub = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', draft.body.id).attach('files', PDF, 'work.pdf').expect(201);
      const sid = sub.body.id;
      await ctx.http().patch(`/api/v1/submissions/${sid}/assign`).set(bearer(admin)).send({ mentorId: ctx.ids.mentorJunior }).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${sid}/start-review`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${sid}/mark`).set(bearer(mentorJ)).field('score', '8').field('mentorFeedback', 'Good.').expect(200);
      await ctx.http().patch(`/api/v1/submissions/${sid}/submit-to-admin`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${sid}/approve`).set(bearer(admin)).send({}).expect(200);
      await ctx.http().patch(`/api/v1/submissions/${sid}/publish`).set(bearer(admin)).expect(200);

      const thread = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ))
        .send({ title: 'Spam', content: 'Buy now' }).expect(201);
      await ctx.http().patch(`/api/v1/threads/${thread.body.id}/hide`).set(bearer(admin)).send({ reason: 'Spam' }).expect(200);
      await waitForEvents();

      const action = async (name: string) => (await entries({ action: name }))[0];
      expect(await action('ASSIGN_MENTOR')).toMatchObject({ entity: 'MentorAssignment', entityId: scope.body.id, actorUsername: 'admin' });
      expect(await action('CREATE_ASSIGNMENT')).toBeTruthy();
      expect((await entries({ action: 'CREATE_ASSIGNMENT', entityId: draft.body.id }))[0]).toMatchObject({ actorUsername: 'mentor.j', actorRole: 'MENTOR' });
      expect((await entries({ action: 'PUBLISH_ASSIGNMENT', entityId: draft.body.id }))[0]).toMatchObject({ actorUsername: 'admin' });
      expect((await entries({ action: 'ASSIGN_SUBMISSION', entityId: sid }))).toHaveLength(1);
      expect((await entries({ action: 'MARK_SUBMISSION', entityId: sid }))[0]).toMatchObject({
        actorUsername: 'mentor.j', metadata: expect.objectContaining({ score: 8 }),
      });
      for (const a of ['START_REVIEW', 'RETURN_REVIEW_TO_ADMIN', 'APPROVE_RESULT']) {
        expect(await entries({ action: a, entityId: sid }), a).toHaveLength(1);
      }
      expect(await action('PUBLISH_RESULTS')).toMatchObject({ actorUsername: 'admin' });
      expect((await entries({ action: 'HIDE_THREAD', entityId: thread.body.id }))[0]).toMatchObject({
        actorUsername: 'admin', metadata: expect.objectContaining({ reason: 'Spam' }),
      });
    });

    it('administrators browse the trail by category, record, actor and date', async () => {
      const get = (q: Record<string, string>) => ctx.http().get('/api/v1/admin/audit-logs').query(q).set(bearer(admin)).expect(200);

      const reviews = (await get({ category: 'REVIEWS', limit: '100' })).body;
      expect(reviews.data.length).toBeGreaterThan(0);
      expect(reviews.data.every((e: any) => e.category === 'REVIEWS')).toBe(true);

      const history = (await get({ entity: 'User', entityId: newUserId })).body;
      expect(history.meta.total).toBe(7);
      expect(history.data[0]).toMatchObject({ action: 'UPDATE_USER_STATUS', actorUsername: 'admin', actor: { username: 'admin', role: 'ADMIN' } });

      const settingsTrail = (await get({ entity: 'SystemSetting', entityId: 'platform.name' })).body;
      expect(settingsTrail.data).toHaveLength(1);

      const byMentor = (await get({ actorId: ctx.ids.mentorJunior })).body;
      expect(byMentor.data.every((e: any) => e.actorUsername === 'mentor.j')).toBe(true);
      expect((await get({ actorRole: 'MENTOR' })).body.meta.total).toBe(byMentor.meta.total);

      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      expect((await get({ from: tomorrow })).body.meta.total).toBe(0);

      const one = await ctx.http().get(`/api/v1/admin/audit-logs/${history.data[0].id}`).set(bearer(admin)).expect(200);
      expect(one.body.id).toBe(history.data[0].id);

      const actions = (await ctx.http().get('/api/v1/admin/audit-logs/actions').set(bearer(admin)).expect(200)).body;
      expect(actions.find((a: any) => a.action === 'CHANGE_USER_ROLE')).toEqual({ action: 'CHANGE_USER_ROLE', category: 'USERS', count: 1 });

      await ctx.http().get('/api/v1/admin/audit-logs').query({ category: 'GOSSIP' }).set(bearer(admin)).expect(400);
      await ctx.http().get('/api/v1/admin/audit-logs').query({ from: '2026-11-10', to: '2026-11-01' }).set(bearer(admin)).expect(400);
    });

    it('exports the filtered trail as CSV, and records the export', async () => {
      const res = await ctx.http().get('/api/v1/admin/audit-logs/export.csv').query({ category: 'SETTINGS' }).set(bearer(admin)).expect(200);
      expect(res.headers['content-type']).toContain('text/csv');
      const lines = res.text.replace(/^﻿/, '').trim().split('\r\n');
      expect(lines[0]).toBe('Time,Category,Action,Actor,Actor role,Record type,Record id,Details');
      expect(lines.slice(1).every((l) => l.includes(',SETTINGS,UPDATE_SETTING,admin,'))).toBe(true);
      expect(await entries({ action: 'EXPORT_AUDIT_LOG' })).toHaveLength(1);
    });

    it('only administrators can read the trail; nobody can change it through the API', async () => {
      for (const token of [mentorJ, studentJ]) {
        await ctx.http().get('/api/v1/admin/audit-logs').set(bearer(token)).expect(403);
        await ctx.http().get('/api/v1/admin/audit-logs/actions').set(bearer(token)).expect(403);
        await ctx.http().get('/api/v1/admin/audit-logs/export.csv').set(bearer(token)).expect(403);
      }
      await ctx.http().get('/api/v1/admin/audit-logs').expect(401);

      const any = (await ctx.prisma.auditLog.findFirstOrThrow()).id;
      await ctx.http().post('/api/v1/admin/audit-logs').set(bearer(admin)).send({ action: 'FAKE', entity: 'X' }).expect(404);
      await ctx.http().patch(`/api/v1/admin/audit-logs/${any}`).set(bearer(admin)).send({ action: 'FAKE' }).expect(404);
      await ctx.http().delete(`/api/v1/admin/audit-logs/${any}`).set(bearer(admin)).expect(404);
    });

    it('the database itself refuses to change or delete audit records', async () => {
      const entry = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'CHANGE_USER_ROLE' } });
      await expect(ctx.prisma.auditLog.update({ where: { id: entry.id }, data: { action: 'NOTHING_HAPPENED' } })).rejects.toThrow(/append-only/);
      await expect(ctx.prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
      await expect(ctx.prisma.auditLog.deleteMany({})).rejects.toThrow(/append-only/);
      expect(await ctx.prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } })).toMatchObject({ action: 'CHANGE_USER_ROLE' });
    });

    it('history keeps who acted even after the account is deleted', async () => {
      const temp = await ctx.prisma.user.create({ data: {
        username: 'temp.admin', email: 'temp@test.local', firstName: 'Temp', lastName: 'Admin', role: 'ADMIN', activatedAt: new Date(),
      } });
      await ctx.prisma.auditLog.create({ data: { actorId: temp.id, actorRole: 'ADMIN', action: 'UPDATE_SETTING', entity: 'SystemSetting', entityId: 'platform.name' } });
      await ctx.prisma.user.delete({ where: { id: temp.id } });

      const kept = await ctx.prisma.auditLog.findFirstOrThrow({ where: { actorUsername: 'temp.admin' } });
      expect(kept).toMatchObject({ actorId: null, actorUsername: 'temp.admin', action: 'UPDATE_SETTING' });
      const shown = await ctx.http().get(`/api/v1/admin/audit-logs/${kept.id}`).set(bearer(admin)).expect(200);
      expect(shown.body).toMatchObject({ actor: null, actorUsername: 'temp.admin' });
    });
  });
});
