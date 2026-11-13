/**
 * Starting an academic year is single-flight and retry-safe (capability `academicYearActivation`).
 *
 * The start rewrites every student's enrolment in one transaction that can outlive the Netlify
 * proxy (~26 s). Before this, a retry while the first start was still running passed the PLANNED
 * check and ran the rollover again; a start of another planned year could close the year just
 * started and promote everyone a second time. Real PostgreSQL, real HTTP.
 */
import { createTestApp, login, bearer, currentYearId, type TestContext } from './helpers.js';

/** Same key as AcademicYearsService (ACTIVATION_LOCK_KEY). */
const LOCK_KEY = 7_302_026_001n;

describe('Academic-year start: single-flight and retry-safe', () => {
  let ctx: TestContext;
  let admin: string, studentJ: string;
  const http = () => ctx.http();
  const audits = (id: string) => ctx.prisma.auditLog.count({ where: { action: 'ACTIVATE_ACADEMIC_YEAR', entityId: id } });
  const grade = async (id: string) => (await ctx.prisma.user.findUniqueOrThrow({ where: { id } })).gradeLevel;
  const plan = async (name: string, startsOn: string, endsOn: string) =>
    (await http().post('/api/v1/admin/academic-years').set(bearer(admin)).send({ name, startsOn, endsOn }).expect(201)).body.id as string;
  const start = (id: string, body: object) => http().post(`/api/v1/admin/academic-years/${id}/activate`).set(bearer(admin)).send(body);

  beforeAll(async () => {
    ctx = await createTestApp();
    [admin, studentJ] = await Promise.all(['admin', 'student.j'].map((u) => login(ctx, u)));
  });
  afterAll(async () => {
    await ctx?.app.close();
  });

  it('advertises academicYearActivation', async () => {
    const res = await http().get('/api/v1').expect(200);
    expect(res.body.capabilities.features).toContain('academicYearActivation');
  });

  let next: string;
  it('expectedCurrentYearId is required (a start is never blind); a malformed one is refused', async () => {
    next = await plan('2027-2028', '2027-09-01', '2028-07-31');
    const missing = await start(next, { promoteStudents: true }).expect(400);
    expect(JSON.stringify(missing.body)).toMatch(/expectedCurrentYearId/);
    await start(next, { promoteStudents: true, expectedCurrentYearId: 'not-a-uuid' }).expect(400);
    expect(await audits(next)).toBe(0);
  });

  it('while another start holds the lock, a start is refused at once (409 ACTIVATION_IN_PROGRESS) and changes nothing', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY}::bigint)`;
      locked();
      await held;
    }, { timeout: 60_000 });
    try {
      await isLocked;
      const res = await start(next, { promoteStudents: true, expectedCurrentYearId: ctx.ids.year }).expect(409);
      expect(res.body.code).toBe('ACTIVATION_IN_PROGRESS');
    } finally {
      release();
      await holder;
    }
    expect(await ctx.prisma.academicYear.findUniqueOrThrow({ where: { id: next } })).toMatchObject({ status: 'PLANNED', isCurrent: null });
    expect(await audits(next)).toBe(0);
  });

  it('a start that expects another current year is refused (409 CURRENT_YEAR_CHANGED) and changes nothing', async () => {
    const stale = await start(next, { promoteStudents: true, expectedCurrentYearId: '00000000-0000-4000-8000-000000000999' }).expect(409);
    expect(stale.body).toMatchObject({ code: 'CURRENT_YEAR_CHANGED', details: { currentYearId: ctx.ids.year } });
    const none = await start(next, { promoteStudents: true, expectedCurrentYearId: null }).expect(409);
    expect(none.body.code).toBe('CURRENT_YEAR_CHANGED');
    expect(await audits(next)).toBe(0);
  });

  it('two identical starts racing: exactly one rollover, one audit entry, students promoted once', async () => {
    const before = await grade(ctx.ids.studentJunior2);   // S3
    expect(before).toBe('S3');
    const body = { promoteStudents: true, deactivateGraduates: true, expectedCurrentYearId: ctx.ids.year };
    const [a, b] = await Promise.all([start(next, body), start(next, body)]);
    const results = [a, b].map((r) => ({ status: r.status, code: r.body.code, replayed: r.body.replayed === true }));
    // One did the work; the other was refused while it ran, or answered from its record after it.
    expect(results.filter((r) => r.status === 200 && !r.replayed)).toHaveLength(1);
    for (const r of results) {
      expect(r.status === 200 || (r.status === 409 && r.code === 'ACTIVATION_IN_PROGRESS')).toBe(true);
    }
    expect(await audits(next)).toBe(1);
    expect(await grade(ctx.ids.studentJunior2)).toBe('S4');   // once, not S5
    expect(await ctx.prisma.academicYear.findUniqueOrThrow({ where: { id: ctx.ids.year } })).toMatchObject({ status: 'CLOSED', isCurrent: null });
    expect(await ctx.prisma.studentEnrollment.count({ where: { academicYearId: next, studentId: ctx.ids.studentJunior2 } })).toBe(1);
  });

  it('a retry after the start went through returns the recorded outcome (replayed) and does nothing again', async () => {
    const closedAt = (await ctx.prisma.academicYear.findUniqueOrThrow({ where: { id: ctx.ids.year } })).closedAt;
    const res = await start(next, { promoteStudents: true, deactivateGraduates: true, expectedCurrentYearId: ctx.ids.year }).expect(200);
    expect(res.body).toMatchObject({ replayed: true, academicYear: { id: next, status: 'ACTIVE', isCurrent: true } });
    expect(res.body.promoted).toBeGreaterThanOrEqual(3);
    expect(await audits(next)).toBe(1);
    expect(await grade(ctx.ids.studentJunior2)).toBe('S4');
    // The previous year's closing time is not rewritten by a repeat.
    expect((await ctx.prisma.academicYear.findUniqueOrThrow({ where: { id: ctx.ids.year } })).closedAt).toEqual(closedAt);
    // deactivateGraduates omitted means true: still the same choice.
    await start(next, { promoteStudents: true, expectedCurrentYearId: ctx.ids.year }).expect(200);
  });

  it('a repeat with other choices or from another current year is refused, not applied', async () => {
    const options = await start(next, { promoteStudents: false, expectedCurrentYearId: ctx.ids.year }).expect(409);
    expect(options.body).toMatchObject({ code: 'ACTIVATION_OPTIONS_DIFFER', details: { recorded: { promoteStudents: true } } });
    const from = await start(next, { promoteStudents: true, expectedCurrentYearId: next }).expect(409);
    expect(from.body.code).toBe('CURRENT_YEAR_CHANGED');
    expect(await audits(next)).toBe(1);
    expect(await grade(ctx.ids.studentJunior2)).toBe('S4');
  });

  it('two DIFFERENT planned years started at once from the same current year: one wins, the other is refused; no double promotion', async () => {
    const y3 = await plan('2028-2029', '2028-09-01', '2029-07-31');
    const y4 = await plan('2029-2030', '2029-09-01', '2030-07-31');
    const current = await currentYearId(ctx);
    expect(current).toBe(next);
    const [a, b] = await Promise.all([
      start(y3, { promoteStudents: true, expectedCurrentYearId: current }),
      start(y4, { promoteStudents: true, expectedCurrentYearId: current }),
    ]);
    const ok = [a, b].filter((r) => r.status === 200);
    const refused = [a, b].filter((r) => r.status === 409);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(['ACTIVATION_IN_PROGRESS', 'CURRENT_YEAR_CHANGED']).toContain(refused[0].body.code);
    expect(await grade(ctx.ids.studentJunior2)).toBe('S5');   // promoted exactly once more
    const years = await ctx.prisma.academicYear.findMany({ where: { id: { in: [y3, y4] } } });
    expect(years.filter((y) => y.status === 'ACTIVE')).toHaveLength(1);
    expect(years.filter((y) => y.status === 'PLANNED')).toHaveLength(1);
  });

  it('a start of a year that has since been closed is refused (INVALID_STATE_TRANSITION), never replayed', async () => {
    // `next` was closed by the start above.
    const res = await start(next, { promoteStudents: true, expectedCurrentYearId: ctx.ids.year }).expect(409);
    expect(res.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('only academicYears.manage may start a year', async () => {
    const y = await ctx.prisma.academicYear.findFirstOrThrow({ where: { status: 'PLANNED' } });
    await http().post(`/api/v1/admin/academic-years/${y.id}/activate`).set(bearer(studentJ))
      .send({ promoteStudents: true, expectedCurrentYearId: await currentYearId(ctx) }).expect(403);
  });
});
