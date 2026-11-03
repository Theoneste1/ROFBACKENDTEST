/**
 * Assignment management: drafting, the admin publication workflow, the
 * CLOSED status (manual and at the deadline), search/filters and history.
 */
import { AssignmentCloserService } from '../src/assignments/assignment-closer.service.js';
import { createTestApp, login, bearer, PDF, inDays, type TestContext } from './helpers.js';

describe('Assignments (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorS: string, studentJ: string, studentS: string;
  let id: string;

  const draft = (token: string, fields: Record<string, string> = {}) => {
    const req = ctx.http().post('/api/v1/assignments').set(bearer(token));
    const all = {
      title: 'Linear inequalities', courseId: ctx.ids.algebra, divisionId: ctx.ids.junior,
      description: 'Warm-up set on inequalities.', instructions: 'Solve all six problems and justify each step.',
      deadline: inDays(7), points: '20', maximumMarks: '10', ...fields,
    };
    for (const [k, v] of Object.entries(all)) req.field(k, v);
    return req;
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorS, studentJ, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.s', 'student.j', 'student.s'].map((u) => login(ctx, u)),
    );
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('creation and validation', () => {
    it('a mentor creates a draft with a description, a brief file and resubmission rules', async () => {
      const res = await draft(mentorJ, { allowResubmission: 'true', maxResubmissions: '2' })
        .attach('files', PDF, 'brief.pdf').expect(201);
      id = res.body.id;
      expect(res.body).toMatchObject({
        status: 'DRAFT', description: 'Warm-up set on inequalities.',
        allowResubmission: true, maxResubmissions: 2, allowLateSubmission: false,
        course: { id: ctx.ids.algebra }, division: { id: ctx.ids.junior },
      });
      expect(res.body.attachments).toHaveLength(1);
    });

    it.each([
      ['a missing title',                    { title: '' }],
      ['an invalid deadline',                { deadline: 'next friday' }],
      ['negative points',                    { points: '-1' }],
      ['zero maximum marks',                 { maximumMarks: '0' }],
      ['a resubmission limit without resubmissions', { maxResubmissions: '2' }],
      ['an over-long description',           { description: 'x'.repeat(501) }],
    ])('rejects %s', async (_label, fields) => {
      await draft(mentorJ, fields).expect(400);
    });

    it('only mentors assigned to the course × division can create', async () => {
      const wrongScope = await draft(mentorS).expect(403);
      expect(wrongScope.body.code).toBe('NOT_ASSIGNED_TO_SCOPE');
      await draft(admin).expect(403);
      await draft(studentJ).expect(403);
    });

    it('edits the draft and keeps the before/after values in the history', async () => {
      await ctx.http().patch(`/api/v1/assignments/${id}`).set(bearer(mentorJ))
        .field('title', 'Linear inequalities (set A)').field('points', '25').expect(200);

      const history = await ctx.http().get(`/api/v1/assignments/${id}/history`).set(bearer(mentorJ)).expect(200);
      expect(history.body.map((e: any) => e.type)).toEqual(['CREATED', 'UPDATED']);
      expect(history.body[1]).toMatchObject({
        actor: { username: 'mentor.j' },
        changes: {
          title:  { from: 'Linear inequalities', to: 'Linear inequalities (set A)' },
          points: { from: 20, to: 25 },
        },
      });
    });
  });

  describe('publication workflow', () => {
    it('submitted drafts are locked for editing; admins reject with a note', async () => {
      await ctx.http().patch(`/api/v1/assignments/${id}/submit`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/assignments/${id}`).set(bearer(mentorJ)).field('title', 'Sneaky edit').expect(409);
      await ctx.http().patch(`/api/v1/assignments/${id}/publish`).set(bearer(mentorJ)).expect(403);

      const rejected = await ctx.http().patch(`/api/v1/assignments/${id}/reject`).set(bearer(admin))
        .send({ rejectionNote: 'Problem 4 has a typo.' }).expect(200);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectionNote: 'Problem 4 has a typo.' });
    });

    it('unpublished work is invisible to students', async () => {
      await ctx.http().get(`/api/v1/assignments/${id}`).set(bearer(studentJ)).expect(404);
    });

    it('after a fix and resubmission the admin publishes it to eligible students only', async () => {
      await ctx.http().patch(`/api/v1/assignments/${id}`).set(bearer(mentorJ))
        .field('instructions', 'Solve all six problems (typo in 4 fixed) and justify each step.').expect(200);
      await ctx.http().patch(`/api/v1/assignments/${id}/submit`).set(bearer(mentorJ)).expect(200);
      await ctx.http().patch(`/api/v1/assignments/${id}/publish`).set(bearer(admin)).expect(200);

      const mine = await ctx.http().get(`/api/v1/assignments/${id}`).set(bearer(studentJ)).expect(200);
      expect(mine.body).toMatchObject({ status: 'PUBLISHED', description: 'Warm-up set on inequalities.', canSubmit: true });
      await ctx.http().get(`/api/v1/assignments/${id}`).set(bearer(studentS)).expect(404);

      // Published assignments can no longer be edited by mentors.
      await ctx.http().patch(`/api/v1/assignments/${id}`).set(bearer(mentorJ)).field('title', 'Late change').expect(409);
    });
  });

  describe('search and filters', () => {
    it('filters by text, status, creator and deadline window', async () => {
      await draft(mentorJ, { title: 'Pigeonhole principle', description: 'Counting', deadline: inDays(30) }).expect(201);

      const text = await ctx.http().get('/api/v1/assignments').query({ q: 'PIGEON' }).set(bearer(mentorJ)).expect(200);
      expect(text.body.data.map((a: any) => a.title)).toEqual(['Pigeonhole principle']);

      const byInstructions = await ctx.http().get('/api/v1/assignments').query({ q: 'typo in 4' }).set(bearer(admin)).expect(200);
      expect(byInstructions.body.data.map((a: any) => a.id)).toEqual([id]);

      const published = await ctx.http().get('/api/v1/assignments').query({ status: 'PUBLISHED' }).set(bearer(admin)).expect(200);
      expect(published.body.data.map((a: any) => a.id)).toEqual([id]);

      const byCreator = await ctx.http().get('/api/v1/assignments')
        .query({ createdById: ctx.ids.mentorJunior }).set(bearer(admin)).expect(200);
      expect(byCreator.body.meta.total).toBeGreaterThanOrEqual(2);
      const byOther = await ctx.http().get('/api/v1/assignments')
        .query({ createdById: ctx.ids.mentorJunior2 }).set(bearer(admin)).expect(200);
      expect(byOther.body.meta.total).toBe(0);

      const soon = await ctx.http().get('/api/v1/assignments')
        .query({ deadlineFrom: inDays(0), deadlineTo: inDays(10) }).set(bearer(mentorJ)).expect(200);
      expect(soon.body.data.map((a: any) => a.title)).not.toContain('Pigeonhole principle');

      await ctx.http().get('/api/v1/assignments').query({ deadlineFrom: 'soon' }).set(bearer(admin)).expect(400);
    });

    it('students only ever get their division\'s visible assignments, whatever they ask for', async () => {
      const drafts = await ctx.http().get('/api/v1/me/assignments').query({ status: 'DRAFT' }).set(bearer(studentJ)).expect(200);
      expect(drafts.body.data).toHaveLength(0);
      const all = await ctx.http().get('/api/v1/assignments').set(bearer(studentJ)).expect(200);
      expect(all.body.data.map((a: any) => a.id)).toEqual([id]);
      const senior = await ctx.http().get('/api/v1/me/assignments').query({ q: 'inequalities' }).set(bearer(studentS)).expect(200);
      expect(senior.body.data).toHaveLength(0);
    });
  });

  describe('closing', () => {
    it('an admin closes it: students still see it but cannot submit', async () => {
      const closed = await ctx.http().patch(`/api/v1/assignments/${id}/close`).set(bearer(admin))
        .send({ note: 'Closed early for the mock exam.' }).expect(200);
      expect(closed.body.status).toBe('CLOSED');
      expect(closed.body.closedAt).toBeTruthy();
      await ctx.http().patch(`/api/v1/assignments/${id}/close`).set(bearer(mentorJ)).send({}).expect(403);

      const list = await ctx.http().get('/api/v1/me/assignments').set(bearer(studentJ)).expect(200);
      expect(list.body.data.find((a: any) => a.id === id)).toMatchObject({ status: 'CLOSED', canSubmit: false });

      const submit = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', id).attach('file', PDF, 'work.pdf').expect(409);
      expect(submit.body.code).toBe('ASSIGNMENT_CLOSED');
    });

    it('reopening after the deadline requires a new future deadline', async () => {
      await ctx.prisma.assignment.update({ where: { id }, data: { deadline: new Date(Date.now() - 60_000) } });

      const missing = await ctx.http().patch(`/api/v1/assignments/${id}/reopen`).set(bearer(admin)).send({}).expect(400);
      expect(missing.body.code).toBe('DEADLINE_REQUIRED');
      await ctx.http().patch(`/api/v1/assignments/${id}/reopen`).set(bearer(admin))
        .send({ deadline: inDays(-1) }).expect(400);

      const reopened = await ctx.http().patch(`/api/v1/assignments/${id}/reopen`).set(bearer(admin))
        .send({ deadline: inDays(3), note: 'Extended after the exam.' }).expect(200);
      expect(reopened.body).toMatchObject({ status: 'PUBLISHED', closedAt: null });

      await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
        .field('assignmentId', id).attach('file', PDF, 'work.pdf').expect(201);
    });

    it('closes automatically when the deadline passes, unless late work is accepted', async () => {
      const base = {
        instructions: 'Solve.', points: 1, maximumMarks: 1, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior,
        academicYearId: ctx.ids.year, createdById: ctx.ids.mentorJunior, status: 'PUBLISHED' as const,
        publishedAt: new Date(), deadline: new Date(Date.now() - 60_000),
      };
      const strict  = await ctx.prisma.assignment.create({ data: { ...base, title: 'Strict' } });
      const lenient = await ctx.prisma.assignment.create({ data: { ...base, title: 'Lenient', allowLateSubmission: true } });

      const closer = ctx.app.get(AssignmentCloserService);
      expect(await closer.closeOverdue()).toBe(1);
      expect(await closer.closeOverdue()).toBe(0);   // idempotent

      const rows = await ctx.prisma.assignment.findMany({ where: { id: { in: [strict.id, lenient.id] } }, orderBy: { title: 'asc' } });
      expect(rows.map((r) => [r.title, r.status])).toEqual([['Lenient', 'PUBLISHED'], ['Strict', 'CLOSED']]);

      const events = await ctx.prisma.assignmentEvent.findMany({ where: { assignmentId: strict.id } });
      expect(events).toEqual([expect.objectContaining({
        type: 'CLOSED', fromStatus: 'PUBLISHED', toStatus: 'CLOSED', actorId: null, note: 'Deadline passed',
      })]);
    });
  });

  describe('history', () => {
    it('records the whole lifecycle with actors, notes and statuses', async () => {
      await ctx.http().patch(`/api/v1/assignments/${id}/archive`).set(bearer(admin)).expect(200);

      const res = await ctx.http().get(`/api/v1/assignments/${id}/history`).set(bearer(admin)).expect(200);
      expect(res.body.map((e: any) => e.type)).toEqual([
        'CREATED', 'UPDATED', 'SUBMITTED_FOR_REVIEW', 'REJECTED', 'UPDATED',
        'SUBMITTED_FOR_REVIEW', 'PUBLISHED', 'CLOSED', 'REOPENED', 'ARCHIVED',
      ]);
      const byType = (t: string) => res.body.filter((e: any) => e.type === t).at(-1);
      expect(byType('REJECTED')).toMatchObject({ note: 'Problem 4 has a typo.', actor: { username: 'admin', role: 'ADMIN' } });
      expect(byType('CLOSED')).toMatchObject({ fromStatus: 'PUBLISHED', toStatus: 'CLOSED', note: 'Closed early for the mock exam.' });
      expect(byType('REOPENED')).toMatchObject({ toStatus: 'PUBLISHED', changes: { deadline: expect.any(Object) } });
      expect(byType('ARCHIVED')).toMatchObject({ fromStatus: 'PUBLISHED', toStatus: 'ARCHIVED' });
    });

    it('is not available to students or to mentors of other divisions', async () => {
      await ctx.http().get(`/api/v1/assignments/${id}/history`).set(bearer(studentJ)).expect(403);
      await ctx.http().get(`/api/v1/assignments/${id}/history`).set(bearer(mentorS)).expect(403);
    });
  });
});
