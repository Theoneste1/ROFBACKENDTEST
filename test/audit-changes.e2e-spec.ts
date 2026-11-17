/**
 * AUD-02 — previous and new values on audited changes: field edits record `changes: { field: { from, to } }` (only
 * the fields that changed) and status transitions record `from` / `to`, in the audit log administrators read.
 */
import { createTestApp, login, bearer, inDays, type TestContext } from './helpers.js';

describe('Audit: previous and new values (e2e)', () => {
  let ctx: TestContext;
  let admin: string, mentorJ: string;
  const http = () => ctx.http();
  const last = (action: string, entityId: string) =>
    ctx.prisma.auditLog.findFirstOrThrow({ where: { action, entityId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, mentorJ] = await Promise.all(['admin', 'mentor.j'].map((u) => login(ctx, u)));
  });
  afterAll(async () => {
    await ctx?.app.close();
  });

  it('course edit: only the changed fields, from → to', async () => {
    const before = await ctx.prisma.course.findUniqueOrThrow({ where: { id: ctx.ids.algebra } });
    await http().patch(`/api/v1/admin/courses/${ctx.ids.algebra}`).set(bearer(admin))
      .send({ title: 'Algebra (revised)', sortOrder: before.sortOrder }).expect(200);
    const row = await last('UPDATE_COURSE', ctx.ids.algebra);
    expect((row.metadata as any).changes).toEqual({ title: { from: before.title, to: 'Algebra (revised)' } });
  });

  it('division and academic year edits record previous and new values', async () => {
    await http().patch(`/api/v1/admin/divisions/${ctx.ids.junior}`).set(bearer(admin)).send({ description: 'Lower secondary (S1–S3)' }).expect(200);
    expect((await last('UPDATE_DIVISION', ctx.ids.junior)).metadata).toMatchObject({
      changes: { description: { to: 'Lower secondary (S1–S3)' } },
    });

    const year = await ctx.prisma.academicYear.findUniqueOrThrow({ where: { id: ctx.ids.year } });
    await http().patch(`/api/v1/admin/academic-years/${ctx.ids.year}`).set(bearer(admin)).send({ name: `${year.name} (edited)` }).expect(200);
    expect((await last('UPDATE_ACADEMIC_YEAR', ctx.ids.year)).metadata).toMatchObject({
      changes: { name: { from: year.name, to: `${year.name} (edited)` } },
    });
  });

  it('assignment: edits carry their changes; each status step carries from / to', async () => {
    const req = http().post('/api/v1/assignments').set(bearer(mentorJ));
    for (const [k, v] of Object.entries({
      title: 'Audit set', courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, description: 'Warm-up set on inequalities.', instructions: 'Solve all six problems and justify each step.',
      deadline: inDays(7), points: '20', maximumMarks: '10',
    })) req.field(k, v);
    const id = (await req.expect(201)).body.id as string;

    await http().patch(`/api/v1/assignments/${id}`).set(bearer(mentorJ)).field('points', '25').expect(200);
    expect((await last('UPDATE_ASSIGNMENT', id)).metadata).toMatchObject({ from: 'DRAFT', to: 'DRAFT', changes: { points: { from: 20, to: 25 } } });

    await http().patch(`/api/v1/assignments/${id}/submit`).set(bearer(mentorJ)).expect(200);
    expect((await last('SUBMIT_ASSIGNMENT_FOR_REVIEW', id)).metadata).toMatchObject({ from: 'DRAFT', to: 'PENDING_APPROVAL' });
    await http().patch(`/api/v1/assignments/${id}/publish`).set(bearer(admin)).expect(200);
    const published = await last('PUBLISH_ASSIGNMENT', id);
    expect(published.metadata).toMatchObject({ from: 'PENDING_APPROVAL', to: 'PUBLISHED', title: 'Audit set' });
    expect(published.actorRole).toBe('ADMIN');
    await http().patch(`/api/v1/assignments/${id}/archive`).set(bearer(admin)).expect(200);
    expect((await last('ARCHIVE_ASSIGNMENT', id)).metadata).toMatchObject({ from: 'PUBLISHED', to: 'ARCHIVED' });
  });

  it('a refused transition writes no audit row', async () => {
    const req = http().post('/api/v1/assignments').set(bearer(mentorJ));
    for (const [k, v] of Object.entries({
      title: 'Refused', courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, description: 'Warm-up set on inequalities.', instructions: 'Solve all six problems and justify each step.',
      deadline: inDays(7), points: '5', maximumMarks: '10',
    })) req.field(k, v);
    const id = (await req.expect(201)).body.id as string;
    await http().patch(`/api/v1/assignments/${id}/publish`).set(bearer(admin)).expect(409);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'PUBLISH_ASSIGNMENT', entityId: id } })).toBe(0);
  });
});
