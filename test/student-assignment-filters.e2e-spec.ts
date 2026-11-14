/**
 * My Assignments at scale: the student's progress filter and the sort run in the database, so
 * paging and totals count only the matches (F2 — the page used to filter 50 loaded rows).
 */
import { createTestApp, login, bearer, inDays, type TestContext } from './helpers.js';

describe('My Assignments: progress filter and sort (e2e)', () => {
  let ctx: TestContext;
  let studentJ: string, admin: string;
  const ids: Record<string, string> = {};

  const assignment = (title: string, data: Record<string, unknown> = {}) => ctx.prisma.assignment.create({
    data: {
      title, instructions: 'Solve.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(), ...data,
    },
  });
  const submission = (assignmentId: string, status: string) => ctx.prisma.submission.create({
    data: { assignmentId, studentId: ctx.ids.studentJunior, status: status as any, submittedAt: new Date(), revisionCount: 1 },
  });
  const list = (query: Record<string, string | number>, token = studentJ) =>
    ctx.http().get('/api/v1/me/assignments').query(query).set(bearer(token));

  beforeAll(async () => {
    ctx = await createTestApp();
    [studentJ, admin] = await Promise.all([login(ctx, 'student.j'), login(ctx, 'admin')]);
    // Not started (×3, open), overdue (×2: past without late work; closed), late allowed (not overdue),
    // and one per submission state.
    for (const t of ['A open 1', 'B open 2', 'C open 3']) ids[t] = (await assignment(t)).id;
    ids.pastNoLate = (await assignment('D past, no late work', { deadline: new Date(inDays(-2)), allowLateSubmission: false })).id;
    ids.closed = (await assignment('E closed early', { status: 'CLOSED', closedAt: new Date() })).id;
    ids.lateOk = (await assignment('F past, late work allowed', { deadline: new Date(inDays(-1)), allowLateSubmission: true })).id;
    const states: Array<[string, string]> = [['submitted', 'SUBMITTED'], ['assigned', 'ASSIGNED'], ['inReview', 'IN_REVIEW'],
      ['marked', 'MARKED'], ['approved', 'APPROVED'], ['resub', 'RESUBMISSION_REQUESTED'], ['published', 'PUBLISHED']];
    for (const [key, status] of states) {
      ids[key] = (await assignment(`G ${key}`, { deadline: new Date(inDays(-3)) })).id;
      await submission(ids[key], status);
    }
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  /** Every id across all pages of a query, and the reported total. */
  async function allPages(query: Record<string, string>) {
    const seen: string[] = [];
    let total = -1;
    for (let page = 1; page < 20; page++) {
      const { body } = await list({ ...query, limit: 2, page }).expect(200);
      total = body.meta.total;
      seen.push(...body.data.map((a: any) => a.id));
      if (page >= body.meta.totalPages) break;
    }
    return { seen, total };
  }

  it('each progress filter returns exactly the matching assignments across pages, with matching totals', async () => {
    const expect_ = {
      NOT_STARTED: ['A open 1', 'B open 2', 'C open 3', 'pastNoLate', 'closed', 'lateOk'],
      SUBMITTED: ['submitted', 'assigned'],
      PENDING_REVIEW: ['inReview', 'marked', 'approved'],
      RESUBMISSION_REQUESTED: ['resub'],
      REVIEWED: ['published'],
      OVERDUE: ['pastNoLate', 'closed'],
    } as const;
    for (const [progress, keys] of Object.entries(expect_)) {
      const { seen, total } = await allPages({ progress });
      expect(total, progress).toBe(keys.length);
      expect(new Set(seen), progress).toEqual(new Set(keys.map((k) => ids[k])));
      expect(seen.length, `${progress}: no duplicates across pages`).toBe(keys.length);
    }
  });

  it('every row still carries the display status the filter matched', async () => {
    const label: Record<string, string> = {
      NOT_STARTED: 'Not Started', SUBMITTED: 'Submitted', PENDING_REVIEW: 'Pending Review',
      RESUBMISSION_REQUESTED: 'Resubmission Requested', REVIEWED: 'Reviewed', OVERDUE: 'Not Started',
    };
    for (const [progress, displayStatus] of Object.entries(label)) {
      const { body } = await list({ progress, limit: 100 }).expect(200);
      for (const a of body.data) expect(a.displayStatus, `${progress} → ${a.title}`).toBe(displayStatus);
      if (progress === 'OVERDUE') for (const a of body.data) expect(a.canSubmit).toBe(false);
    }
  });

  it('sorts in the database: deadline (default), -deadline, title; stable across pages', async () => {
    const rows = async (sort?: string) => {
      const out: Array<{ title: string; deadline: number }> = [];
      for (let page = 1; page <= 10; page++) {
        const { body } = await list({ limit: 4, page, ...(sort && { sort }) }).expect(200);
        out.push(...body.data.map((a: any) => ({ title: a.title, deadline: new Date(a.deadline).getTime() })));
        if (page >= body.meta.totalPages) break;
      }
      return out;
    };
    const byTitle = (await rows('title')).map((r) => r.title);
    expect(byTitle).toEqual([...byTitle].sort((a, b) => a.localeCompare(b)));
    expect(byTitle).toHaveLength(13);
    const soonest = (await rows()).map((r) => r.deadline);
    const latest = (await rows('-deadline')).map((r) => r.deadline);
    expect(soonest).toEqual([...soonest].sort((a, b) => a - b));
    expect(latest).toEqual([...latest].sort((a, b) => b - a));
    expect(soonest).toHaveLength(13);
  });

  it('staff lists page several statuses in the database (statuses=DRAFT,REJECTED), totals included', async () => {
    const mentorJ = await login(ctx, 'mentor.j');
    for (const [title, status] of [['H draft 1', 'DRAFT'], ['H draft 2', 'DRAFT'], ['H rejected', 'REJECTED'], ['H pending', 'PENDING_APPROVAL']] as const) {
      await assignment(title, { status, publishedAt: null });
    }
    const seen: string[] = [];
    let total = -1;
    for (let page = 1; page <= 5; page++) {
      const { body } = await ctx.http().get('/api/v1/assignments').query({ statuses: 'DRAFT,REJECTED', limit: 2, page }).set(bearer(mentorJ)).expect(200);
      total = body.meta.total;
      seen.push(...body.data.map((a: any) => a.status));
      if (page >= body.meta.totalPages) break;
    }
    expect(total).toBe(3);
    expect(seen.sort()).toEqual(['DRAFT', 'DRAFT', 'REJECTED']);
    await ctx.http().get('/api/v1/assignments').query({ statuses: 'DRAFT,NOPE' }).set(bearer(mentorJ)).expect(400);
    await ctx.http().get('/api/v1/assignments').query({ status: 'DRAFT', statuses: 'REJECTED' }).set(bearer(mentorJ)).expect(400);
    // Students: only visible statuses, whatever they ask for.
    const drafts = await list({ statuses: 'DRAFT,PUBLISHED', limit: 100 }).expect(200);
    expect(drafts.body.data.every((a: any) => a.status === 'PUBLISHED')).toBe(true);
  });

  it('filters are validated, combine with search and course, and are not accepted on staff lists', async () => {
    await list({ progress: 'DONE' }).expect(400);
    await list({ sort: 'random' }).expect(400);
    const { body } = await list({ progress: 'NOT_STARTED', q: 'open' }).expect(200);
    expect(body.meta.total).toBe(3);
    const none = await list({ progress: 'NOT_STARTED', courseId: ctx.ids.geometry }).expect(200);
    expect(none.body.meta.total).toBe(0);
    // Staff lists never silently ignore a student-only parameter.
    await ctx.http().get('/api/v1/assignments').query({ progress: 'OVERDUE' }).set(bearer(admin)).expect(400);
  });
});
