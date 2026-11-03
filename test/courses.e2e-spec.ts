/**
 * Courses (fixed curriculum, visibility, discussions switch) and learning
 * resources (metadata, filtering, permissions).
 */
import { createTestApp, login, bearer, PDF, type TestContext } from './helpers.js';

describe('Courses and resources (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string, mentorS: string, studentJ: string, studentS: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ, mentorS, studentJ, studentS] = await Promise.all(
      ['admin', 'mentor.j', 'mentor.s', 'student.j', 'student.s'].map((u) => login(ctx, u)),
    );
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  describe('courses', () => {
    it('lists the four Mathematics courses with their details', async () => {
      const res = await ctx.http().get('/api/v1/courses').set(bearer(studentJ)).expect(200);
      expect(res.body.map((c: any) => c.code)).toEqual(['ALGEBRA', 'GEOMETRY', 'NUMBER_THEORY', 'COMBINATORICS']);

      const one = await ctx.http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(studentJ)).expect(200);
      expect(one.body).toMatchObject({ id: ctx.ids.algebra, code: 'ALGEBRA', discussionsEnabled: true });
    });

    it('nobody can create curriculum courses; mentors cannot edit them', async () => {
      await ctx.http().post('/api/v1/courses').set(bearer(mentorJ)).send({ title: 'Calculus' }).expect(404);
      await ctx.http().post('/api/v1/admin/courses').set(bearer(admin)).send({ title: 'Calculus' }).expect(404);
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}`).set(bearer(mentorJ))
        .send({ description: 'Mentors may not change this.' }).expect(403);
      expect(await ctx.prisma.course.count()).toBe(4);
    });

    it('admins manage descriptions and visibility', async () => {
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.geometry}`).set(bearer(admin))
        .send({ description: 'Euclidean and coordinate geometry.' }).expect(200);
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.geometry}/unpublish`).set(bearer(admin)).expect(200);

      const hidden = await ctx.http().get('/api/v1/courses').set(bearer(studentJ)).expect(200);
      expect(hidden.body.map((c: any) => c.id)).not.toContain(ctx.ids.geometry);

      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.geometry}/publish`).set(bearer(admin)).expect(200);
      const shown = await ctx.http().get(`/api/v1/courses/${ctx.ids.geometry}`).set(bearer(studentJ)).expect(200);
      expect(shown.body.description).toBe('Euclidean and coordinate geometry.');
    });
  });

  describe('course discussions switch', () => {
    let threadId: string;

    beforeAll(async () => {
      const t = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ))
        .send({ title: 'Factoring question', content: 'How do I factor x^2 - 5x + 6?' }).expect(201);
      threadId = t.body.id;
    });

    afterAll(async () => {
      await ctx.prisma.course.update({ where: { id: ctx.ids.algebra }, data: { discussionsEnabled: true } });
    });

    it('when turned off, threads stay readable but nobody can post', async () => {
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}`).set(bearer(admin))
        .send({ discussionsEnabled: false }).expect(200);

      await ctx.http().get(`/api/v1/threads/${threadId}/comments`).set(bearer(studentJ)).expect(200);
      const reply = await ctx.http().post(`/api/v1/threads/${threadId}/comments`).set(bearer(mentorJ))
        .send({ content: 'Find two numbers…' }).expect(409);
      expect(reply.body.code).toBe('DISCUSSIONS_DISABLED');
      await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ))
        .send({ title: 'Another one', content: 'Hello?' }).expect(409);

      const audit = await ctx.prisma.auditLog.findFirst({
        where: { action: 'UPDATE_COURSE', entityId: ctx.ids.algebra }, orderBy: { createdAt: 'desc' },
      });
      expect(audit?.metadata).toMatchObject({ discussionsEnabled: false });
    });

    it('turning them back on allows posting again', async () => {
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}`).set(bearer(admin))
        .send({ discussionsEnabled: true }).expect(200);
      await ctx.http().post(`/api/v1/threads/${threadId}/comments`).set(bearer(mentorJ))
        .send({ content: 'Find two numbers that multiply to 6.' }).expect(201);
    });

    it('only admins can switch discussions', async () => {
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}`).set(bearer(mentorJ))
        .send({ discussionsEnabled: false }).expect(403);
      await ctx.http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}`).set(bearer(admin))
        .send({ discussionsEnabled: 'nope' }).expect(400);
    });
  });

  describe('resource metadata', () => {
    let paperId: string;
    const base = () => `/api/v1/courses/${ctx.ids.algebra}/resources`;

    beforeAll(async () => {
      const paper = await ctx.http().post(base()).set(bearer(mentorJ))
        .field('divisionId', ctx.ids.junior).field('type', 'PAST_PAPER').field('title', 'National Olympiad 2024, round 1')
        .field('description', 'Six problems, 3 hours.').field('source', 'Rwanda National Olympiad')
        .field('year', '2024').field('tags', 'Olympiad, inequalities, olympiad')
        .attach('file', PDF, 'paper.pdf').expect(201);
      paperId = paper.body.id;
      expect(paper.body).toMatchObject({
        type: 'PAST_PAPER', source: 'Rwanda National Olympiad', year: 2024, tags: ['olympiad', 'inequalities'],
      });

      await ctx.http().post(base()).set(bearer(mentorJ))
        .field('divisionId', ctx.ids.junior).field('type', 'BOOK').field('title', 'Algebra basics')
        .field('author', 'A. Mentor').field('tags', 'basics').expect(201);

      await ctx.http().patch(`${base()}/${paperId}/publish`).set(bearer(mentorJ)).expect(200);
    });

    it('filters by tag, year, type and free-text search', async () => {
      const byTag = await ctx.http().get(base()).query({ tag: 'Inequalities' }).set(bearer(mentorJ)).expect(200);
      expect(byTag.body.map((r: any) => r.id)).toEqual([paperId]);

      const byYear = await ctx.http().get(base()).query({ year: 2024 }).set(bearer(mentorJ)).expect(200);
      expect(byYear.body).toHaveLength(1);

      const byAuthor = await ctx.http().get(base()).query({ q: 'a. mentor' }).set(bearer(mentorJ)).expect(200);
      expect(byAuthor.body.map((r: any) => r.title)).toEqual(['Algebra basics']);

      const byType = await ctx.http().get(base()).query({ type: 'BOOK' }).set(bearer(mentorJ)).expect(200);
      expect(byType.body.map((r: any) => r.title)).toEqual(['Algebra basics']);
    });

    it('students only see published resources of their division', async () => {
      const junior = await ctx.http().get(base()).set(bearer(studentJ)).expect(200);
      expect(junior.body.map((r: any) => r.id)).toEqual([paperId]);   // the book is unpublished
      expect(junior.body[0].tags).toEqual(['olympiad', 'inequalities']);

      const senior = await ctx.http().get(base()).set(bearer(studentS)).expect(200);
      expect(senior.body).toHaveLength(0);
      await ctx.http().get(`${base()}/${paperId}/file`).set(bearer(studentS)).expect(404);
      await ctx.http().get(`${base()}/${paperId}/file`).set(bearer(studentJ)).expect(200);
    });

    it('updates metadata and validates it', async () => {
      const res = await ctx.http().patch(`${base()}/${paperId}`).set(bearer(mentorJ))
        .send({ tags: ['olympiad', 'Round 1'], year: 2023 }).expect(200);
      expect(res.body).toMatchObject({ tags: ['olympiad', 'round 1'], year: 2023 });

      await ctx.http().patch(`${base()}/${paperId}`).set(bearer(mentorJ)).send({ year: 99 }).expect(400);
      await ctx.http().patch(`${base()}/${paperId}`).set(bearer(mentorJ))
        .send({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }).expect(400);
      await ctx.http().patch(`${base()}/${paperId}`).set(bearer(mentorJ)).send({ tags: ['<script>'] }).expect(400);
    });

    it('only mentors of the scope (or admins) can change a resource', async () => {
      await ctx.http().patch(`${base()}/${paperId}`).set(bearer(mentorS)).send({ title: 'Hijacked' }).expect(403);
      await ctx.http().patch(`${base()}/${paperId}`).set(bearer(studentJ)).send({ title: 'Hijacked' }).expect(403);
      await ctx.http().delete(`${base()}/${paperId}`).set(bearer(studentJ)).expect(403);

      // Admins can manage access to any resource.
      await ctx.http().patch(`${base()}/${paperId}/unpublish`).set(bearer(admin)).expect(200);
      await ctx.http().get(`${base()}/${paperId}`).set(bearer(studentJ)).expect(404);
    });
  });
});
