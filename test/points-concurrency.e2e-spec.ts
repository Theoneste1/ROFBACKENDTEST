/**
 * Points under concurrency: publishing results (and correcting them, and the
 * maintenance recompute) keep User.points / problemsSolved equal to the sum of
 * the student's published results, also when they run at the same time.
 *
 * The interleavings are forced, not hoped for: a separate transaction holds an
 * EXCLUSIVE lock on "AuditLog", which pauses a publication after it has written
 * the student's points but before it commits (its audit entry is the last
 * write). A second operation is started while the first is paused, and both
 * are then released.
 */
import { randomUUID } from 'node:crypto';
import { createTestApp, login, bearer, inDays, type TestContext } from './helpers.js';

describe('Points under concurrent publication (e2e)', () => {
  let ctx: TestContext;
  let admin: string;

  /** Assignments are created directly (published, junior algebra, 40 points for 20 marks). */
  const assignment = (title: string) => ctx.prisma.assignment.create({
    data: {
      title, description: 'Concurrency fixture', instructions: '-', deadline: new Date(inDays(5)),
      points: 40, maximumMarks: 20, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
    },
  });
  /** An APPROVED submission with an APPROVED review of `score` (out of 20), ready to publish. */
  const approved = async (assignmentId: string, studentId: string, score: number) => {
    const sub = await ctx.prisma.submission.create({
      data: { assignmentId, studentId, status: 'APPROVED', submittedAt: new Date(), revisionCount: 1 },
    });
    const review = await ctx.prisma.mentorReview.create({
      data: {
        submissionId: sub.id, cycle: 1, mentorId: ctx.ids.mentorJunior, status: 'APPROVED',
        score, percentage: (score / 20) * 100, feedback: 'ok', markedAt: new Date(), decidedAt: new Date(),
      },
    });
    await ctx.prisma.submission.update({ where: { id: sub.id }, data: { currentReviewId: review.id } });
    return sub.id;
  };
  const student = (n: string) => ctx.prisma.user.create({
    data: {
      username: `conc.${n}.${randomUUID().slice(0, 6)}`, firstName: n, lastName: 'Test', email: `conc.${n}.${randomUUID().slice(0, 6)}@test.local`,
      role: 'STUDENT', gradeLevel: 'S2', divisionId: ctx.ids.junior, activatedAt: new Date(),
    },
  });
  const publish = (assignmentId: string) =>
    ctx.http().post(`/api/v1/assignments/${assignmentId}/results/publish`).set(bearer(admin)).send({}).then((r) => r);

  /** The cached points must equal the published results. */
  async function expectConsistent(studentIds: string[]) {
    for (const id of studentIds) {
      const agg = await ctx.prisma.submission.aggregate({ where: { studentId: id, status: 'PUBLISHED' }, _sum: { pointsAwarded: true }, _count: { _all: true } });
      const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id }, select: { points: true, problemsSolved: true } });
      expect({ points: u.points, problemsSolved: u.problemsSolved }, `student ${id}`)
        .toEqual({ points: agg._sum.pointsAwarded ?? 0, problemsSolved: agg._count._all });
    }
  }

  /** Number of lock requests that are currently waiting in this database. */
  const waiting = async () => Number((await ctx.prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE NOT l.granted AND a.datname = current_database()`)[0].n);
  async function waitUntil(cond: () => Promise<boolean>, what: string) {
    for (let i = 0; i < 200; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error(`timed out waiting for: ${what}`);
  }

  /** Hold an EXCLUSIVE lock on AuditLog until the returned release() is called. */
  async function holdAuditLog() {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    const holder = ctx.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`LOCK TABLE "AuditLog" IN EXCLUSIVE MODE`;
      locked();
      await gate;
    }, { maxWait: 10_000, timeout: 60_000 });
    await isLocked;
    return async () => { release(); await holder; };
  }

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('two publications for the same student cannot overwrite each other\'s points', async () => {
    const x = (await student('x')).id;
    const a = await assignment('Concurrency A');
    const b = await assignment('Concurrency B');
    await approved(a.id, x, 20);   // 40 points
    await approved(b.id, x, 10);   // 20 points

    const release = await holdAuditLog();
    const first = publish(a.id);                    // writes X's points, then waits on its audit entry
    await waitUntil(async () => (await waiting()) >= 1, 'publication A paused before commit');
    const second = publish(b.id);                   // must not compute X's total without A
    await waitUntil(async () => (await waiting()) >= 2, 'publication B waiting');
    await release();

    const [ra, rb] = await Promise.all([first, second]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect([ra.body.published, rb.body.published]).toEqual([1, 1]);
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: x } });
    expect({ points: u.points, problemsSolved: u.problemsSolved }).toEqual({ points: 60, problemsSolved: 2 });
    await expectConsistent([x]);
  });

  it('the maintenance recompute cannot overwrite points of a publication in progress', async () => {
    const y = (await student('y')).id;
    const c = await assignment('Concurrency C');
    await approved(c.id, y, 15);   // 30 points

    const release = await holdAuditLog();
    const publication = publish(c.id);
    await waitUntil(async () => (await waiting()) >= 1, 'publication C paused before commit');
    const recompute = ctx.http().post('/api/v1/admin/leaderboard/recompute').set(bearer(admin)).send({}).then((r) => r);
    await waitUntil(async () => (await waiting()) >= 2, 'recompute waiting');
    await release();

    const [rp, rr] = await Promise.all([publication, recompute]);
    expect(rp.status).toBe(200);
    expect(rr.status).toBe(200);
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: y } });
    expect(u.points).toBe(30);
    await expectConsistent([y]);
  });

  it('a correction (reopen) and a publication for the same student keep the points exact', async () => {
    const z = (await student('z')).id;
    const d = await assignment('Concurrency D');
    const e = await assignment('Concurrency E');
    const subD = await approved(d.id, z, 20);   // 40 points, published now and then reopened
    await approved(e.id, z, 5);                 // 10 points, published concurrently with the reopen
    expect((await publish(d.id)).status).toBe(200);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: z } })).points).toBe(40);

    const release = await holdAuditLog();
    const reopen = ctx.http().patch(`/api/v1/submissions/${subD}/reopen`).set(bearer(admin))
      .send({ reopenNote: 'Concurrency check.' }).then((r) => r);
    await waitUntil(async () => (await waiting()) >= 1, 'reopen paused before commit');
    const publication = publish(e.id);
    await waitUntil(async () => (await waiting()) >= 2, 'publication E waiting');
    await release();

    const [ro, rp] = await Promise.all([reopen, publication]);
    expect([ro.status, rp.status]).toEqual([200, 200]);
    const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id: z } });
    expect({ points: u.points, problemsSolved: u.problemsSolved }).toEqual({ points: 10, problemsSolved: 1 });
    await expectConsistent([z]);
  });

  it('concurrent publications over the same students in opposite orders never deadlock', async () => {
    const students = await Promise.all(['p', 'q', 'r', 's', 't', 'u'].map(student));
    const ids = students.map((s) => s.id);
    for (let round = 0; round < 6; round++) {
      const left = await assignment(`Order L${round}`);
      const right = await assignment(`Order R${round}`);
      for (const id of ids) await approved(left.id, id, 20);
      for (const id of [...ids].reverse()) await approved(right.id, id, 10);
      const [rl, rr] = await Promise.all([publish(left.id), publish(right.id)]);
      expect([rl.status, rr.status], `round ${round}: ${JSON.stringify([rl.body, rr.body]).slice(0, 300)}`).toEqual([200, 200]);
      expect([rl.body.published, rr.body.published]).toEqual([ids.length, ids.length]);
    }
    await expectConsistent(ids);
    for (const id of ids) expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id } })).points).toBe(6 * 60);
  });
});
