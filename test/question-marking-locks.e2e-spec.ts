import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
/**
 * Question-level marking — locks and races on real PostgreSQL (design Rev 5.2 §6, addenda 5.1 and 5.2). Separate
 * connections (a pg Client holding locks as a barrier; parallel API requests; parallel Prisma transactions), repeated runs,
 * exact row counts after each. What PostgreSQL actually locks is read with pgrowlocks from a second connection.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { lockCoaches, lockPapers, lockTasks, lockedNow } from '../src/test-management/question/question-store.js';
import { createTestApp, login, bearer, PDF, type TestContext } from './helpers.js';

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Measurements for the completion report (also printed): appended to <tmp>/qm-reports.jsonl. */
const qmReport = (kind: string, data: unknown) => appendFileSync(join(tmpdir(), 'qm-reports.jsonl'), JSON.stringify({ kind, at: new Date().toISOString(), data }) + '\n');

describe('Question-level marking — locks and races (real PostgreSQL)', () => {
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });   // repeated races and loads take minutes, not seconds
  let ctx: TestContext;
  let admin: string, hm: string, maths: string, sj: string, stJ: string;
  const coaches: Array<{ id: string; token: string }> = [];
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const T = '/api/v1/admin/tests';
  const MT = '/api/v1/marking/tasks';
  const QM = (id: string) => `${T}/${id}/question-marking`;
  const client = async () => { const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); return c; };
  const claim = (token: string, code: string, ref: string) => http().post(`${MT}/${code}/${ref}/claim`).set(bearer(token)).send({});
  const taskOf = async (testId: string, order: number) => p().testQuestionTask.findFirstOrThrow({ where: { submission: { testId, studentId: stJ }, question: { order }, round: 'FIRST' } });

  /** A QUESTION-mode test with n one-mark questions, every race coach a marker of every question, Kaline's answer, tasks generated. */
  const ready = async (n: number) => {
    const res = await http().post(T).set(bearer(admin)).send({
      title: `Locks ${randomUUID().slice(0, 6)}`, subjectId: maths, division: 'ALL', answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(60), maxMarks: n,
      questions: Array.from({ length: n }, (_, i) => ({ prompt: `Q${i + 1}`, maxMarks: 1 })),
    }).expect(201);
    const id = res.body.id as string;
    await http().put(`${T}/${id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'g.pdf').expect(200);
    await http().post(`${T}/${id}/publish`).set(bearer(admin)).expect(200);
    await http().patch(`${QM(id)}/mode`).set(bearer(hm)).send({ mode: 'QUESTION' }).expect(200);
    for (const q of await p().testQuestion.findMany({ where: { testId: id } })) {
      await http().put(`${QM(id)}/questions/${q.id}/markers`).set(bearer(hm)).send({ add: coaches.map((c) => c.id) }).expect(200);
    }
    await http().post(`/api/v1/me/tests/${id}/submission`).set(bearer(sj)).send({ clientKey: randomUUID(), typedAnswer: 'answers' }).expect(201);
    await p().$executeRaw`UPDATE "Test" SET "closesAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second', "opensAt" = (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 hours' WHERE "id" = ${id}`;
    await http().post(`${QM(id)}/tasks/generate`).set(bearer(hm)).send({}).expect(200);
    const sub = await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId: id, studentId: stJ } } });
    return { id, code: sub.publicCode, submissionId: sub.id };
  };

  beforeAll(async () => {
    process.env.QUESTION_MARKING_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const hmId = (await p().user.create({ data: { username: 'qml.head', firstName: 'H', lastName: 'C', email: 'qml.head@test.local', role: 'HEAD_COACH', passwordHash: hash, activatedAt: new Date() } })).id;
    await p().programmeMembership.create({ data: { userId: hmId, disciplineId: maths, source: 'MANUAL' } });
    for (let i = 0; i < 20; i++) {
      const id = (await p().user.create({ data: { username: `qml.c${i}`, firstName: 'C', lastName: `${i}`, email: `qml.c${i}@test.local`, role: 'MENTOR', passwordHash: hash, activatedAt: new Date() } })).id;
      await p().markerAuthorization.create({ data: { coachId: id, disciplineId: maths, grantedById: ctx.ids.admin } });
      coaches.push({ id, token: '' });
    }
    admin = await login(ctx, 'admin');
    hm = await login(ctx, 'qml.head');
    for (let i = 0; i < 20; i++) coaches[i].token = await login(ctx, `qml.c${i}`);
    sj = await login(ctx, 'student.j');
    stJ = ctx.ids.studentJunior;
    await p().$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS pgrowlocks');
  });
  afterAll(async () => {
    delete process.env.QUESTION_MARKING_ENABLED; delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('lock modes PostgreSQL actually takes: claims hold the paper No Key Update, reviews Update, finalMarkingId needs Update; tasks No Key Update', async () => {
    const { id, submissionId } = await ready(1);
    const task = await taskOf(id, 1);
    const watcher = await client();
    const rowLocks = async (table: string) => (await watcher.query(`SELECT array_to_string(modes, ',') AS m FROM pgrowlocks('"${table}"')`)).rows.map((r) => r.m);
    for (const mode of ['NO KEY UPDATE', 'UPDATE'] as const) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const seen: Record<string, string[]> = {};
      const txDone = p().$transaction(async (tx) => {
        await lockCoaches(tx, [coaches[0].id]);
        await lockPapers(tx, [submissionId], mode);
        await lockTasks(tx, [task.id]);
        await lockedNow(tx);
        await sleep(300);
        seen.paper = await rowLocks('TestSubmission');
        seen.task = await rowLocks('TestQuestionTask');
        seen.advisory = (await watcher.query(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND granted`)).rows.map((r) => String(r.n));
        await gate;
      }, { timeout: 20_000 });
      await sleep(600);
      release();
      await txDone;
      // pgrowlocks names an explicit lock "For …", the lock of an UPDATE statement without it.
      expect(seen.paper).toEqual([mode === 'UPDATE' ? 'For Update' : 'For No Key Update']);
      expect(seen.task).toEqual(['For No Key Update']);
      expect(seen.advisory).toEqual(['1']);
    }
    // CHANGING a column with a plain unique index takes the full Update lock — the rule that applies to finalMarkingId
    // (unique), so only reviews, which already hold the paper FOR UPDATE, set it. publicCode has the same kind of index;
    // a value written unchanged takes No Key Update only.
    const writer = await client();
    await writer.query('BEGIN');
    await writer.query(`UPDATE "TestSubmission" SET "publicCode" = 'ZZZZ-ZZZZ' WHERE "id" = $1`, [submissionId]);
    expect(await rowLocks('TestSubmission')).toEqual(['Update']);
    await writer.query('ROLLBACK');
    await writer.query('BEGIN');
    await writer.query(`UPDATE "TestSubmission" SET "finalMarkingId" = "finalMarkingId" WHERE "id" = $1`, [submissionId]);
    expect(await rowLocks('TestSubmission')).toEqual(['No Key Update']);
    await writer.query('ROLLBACK');
    await writer.end();
    // A status-only update takes No Key Update.
    const probe2 = p().$transaction(async (tx) => { await tx.$executeRaw`UPDATE "TestSubmission" SET "updatedAt" = now() WHERE "id" = ${submissionId}`; await sleep(500); });
    await sleep(200);
    expect(await rowLocks('TestSubmission')).toEqual(['No Key Update']);
    await probe2;
    await watcher.end();
  });

  it('T1 (5.2 §1): a claim that WAITS for the paper lock while the old claim expires succeeds (the timestamp is taken after the locks)', async () => {
    for (let run = 0; run < 3; run++) {
      const { id, code, submissionId } = await ready(1);
      await claim(coaches[1].token, code, 'q1').expect(200);
      const t = await taskOf(id, 1);
      await p().$executeRaw`UPDATE "TestQuestionTask" SET "lockExpiresAt" = clock_timestamp() + interval '1500 milliseconds' WHERE "id" = ${t.id}`;
      const holder = await client();
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM "TestSubmission" WHERE "id" = $1 FOR UPDATE`, [submissionId]);
      const pending = claim(coaches[2].token, code, 'q1');          // starts before the expiry, waits at L2
      await sleep(2500);                                            // the old lock expires while it waits
      await holder.query('COMMIT'); await holder.end();
      const r = await pending;
      expect(r.status).toBe(200);
      const claims = await p().testTaskClaim.findMany({ where: { taskId: t.id }, orderBy: { claimedAt: 'asc' }, select: { coachId: true, endReason: true } });
      expect(claims).toEqual([{ coachId: coaches[1].id, endReason: 'EXPIRED' }, { coachId: coaches[2].id, endReason: null }]);
      await http().post(`${MT}/${code}/q1/release`).set(bearer(coaches[2].token)).send({}).expect(200);
    }
    // Control: the old claim still live when the lock is granted → TASK_TAKEN.
    const { id, code, submissionId } = await ready(1);
    await claim(coaches[1].token, code, 'q1').expect(200);
    const holder = await client();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM "TestSubmission" WHERE "id" = $1 FOR UPDATE`, [submissionId]);
    const pending = claim(coaches[2].token, code, 'q1');
    await sleep(800);
    await holder.query('COMMIT'); await holder.end();
    expect((await pending).body.code).toBe('TASK_TAKEN');
    await http().post(`${MT}/${code}/q1/release`).set(bearer(coaches[1].token)).send({}).expect(200);
    expect(await p().testTaskClaim.count({ where: { task: { submission: { testId: id } }, endedAt: null } })).toBe(0);
  });

  it('T2 (5.2 §2): a coach losing an expired task while claiming another keeps an exact count; never above the limit', async () => {
    for (let run = 0; run < 10; run++) {
      const { id, code } = await ready(4);
      const B = coaches[3], A = coaches[4];
      await claim(B.token, code, 'q1').expect(200);
      await claim(B.token, code, 'q2').expect(200);
      await claim(B.token, code, 'q3').expect(200);                  // B at the limit (3)
      const t1 = await taskOf(id, 1);
      await p().$executeRaw`UPDATE "TestQuestionTask" SET "lockExpiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${t1.id}`;
      const [ra, rb] = await Promise.all([claim(A.token, code, 'q1'), claim(B.token, code, 'q4')]);
      expect([ra.status, rb.status]).toEqual([200, 200]);
      const open = await p().testTaskClaim.findMany({ where: { task: { submission: { testId: id } }, endedAt: null }, select: { coachId: true } });
      expect(open.filter((o) => o.coachId === B.id).length).toBe(3);
      expect(open.filter((o) => o.coachId === A.id).length).toBe(1);
      expect(await p().testTaskClaim.count({ where: { taskId: t1.id, endReason: 'EXPIRED' } })).toBe(1);
      for (const [tok, ref] of [[A.token, 'q1'], [B.token, 'q2'], [B.token, 'q3'], [B.token, 'q4']] as const) await http().post(`${MT}/${code}/${ref}/release`).set(bearer(tok)).send({}).expect(200);
    }
    // Five tabs of one coach at once: never more than the limit.
    const { id, code } = await ready(6);
    const C = coaches[5];
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => claim(C.token, code, `q${n}`)));
    expect(results.filter((r) => r.status === 200).length).toBe(3);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'CLAIM_LIMIT')).toBe(true);
    expect(await p().testTaskClaim.count({ where: { coachId: C.id, endedAt: null } })).toBe(3);
    for (const n of [1, 2, 3, 4, 5]) await http().post(`${MT}/${code}/q${n}/release`).set(bearer(C.token)).send({});
    expect(await p().testTaskClaim.count({ where: { task: { submission: { testId: id } }, endedAt: null } })).toBe(0);
  });

  it('T3: the holder changes before locking — no claim is ended wrongly; one holder at the end', async () => {
    const { id, code, submissionId } = await ready(1);
    const [B, C, A] = [coaches[6], coaches[7], coaches[8]];
    await claim(B.token, code, 'q1').expect(200);
    const t = await taskOf(id, 1);
    await p().$executeRaw`UPDATE "TestQuestionTask" SET "lockExpiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${t.id}`;
    const holder = await client();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM "TestSubmission" WHERE "id" = $1 FOR UPDATE`, [submissionId]);
    const pc = claim(C.token, code, 'q1');                           // discovers holder B, waits
    await sleep(300);
    const pa = claim(A.token, code, 'q1');                           // discovers holder B, waits behind C
    await sleep(300);
    await holder.query('COMMIT'); await holder.end();
    const [rc, ra] = await Promise.all([pc, pa]);
    // Exactly one of C and A wins (PostgreSQL decides the order); the other is refused; B's claim ends once.
    const winner = rc.status === 200 ? C : A;
    expect([rc.status, ra.status].sort()).toEqual([200, 409]);
    expect(['TASK_TAKEN', 'TASK_CHANGED']).toContain((rc.status === 200 ? ra : rc).body.code);
    const claims = await p().testTaskClaim.findMany({ where: { taskId: t.id }, orderBy: { claimedAt: 'asc' }, select: { coachId: true, endReason: true } });
    expect(claims).toEqual([{ coachId: B.id, endReason: 'EXPIRED' }, { coachId: winner.id, endReason: null }]);
    await http().post(`${MT}/${code}/q1/release`).set(bearer(winner.token)).send({}).expect(200);
  });

  it('T5–T6: revocation against a simultaneous save and a simultaneous claim — nothing of that coach is written after revocation commits', async () => {
    for (let run = 0; run < 5; run++) {
      const { id, code } = await ready(2);
      const D = coaches[9];
      await claim(D.token, code, 'q1').expect(200);
      const auth = await p().markerAuthorization.findFirstOrThrow({ where: { coachId: D.id, disciplineId: maths, revokedAt: null } });
      const [rev, sv, cl] = await Promise.all([
        http().post(`/api/v1/admin/test-markers/${auth.id}/revoke`).set(bearer(admin)).send({ reason: 'Race check' }),
        http().put(`${MT}/${code}/q1/marks`).set(bearer(D.token)).send({ marks: 1 }),
        claim(D.token, code, 'q2'),
      ]);
      expect(rev.status).toBe(200);
      expect([200, 409]).toContain(sv.status);
      expect([200, 403, 409]).toContain(cl.status);
      const revokedAt = (await p().markerAuthorization.findUniqueOrThrow({ where: { id: auth.id } })).revokedAt!;
      const stillOpen = await p().testTaskClaim.findMany({ where: { coachId: D.id, endedAt: null }, select: { claimedAt: true, task: { select: { question: { select: { order: true } } } } } });
      expect(stillOpen.length).toBe(0);                                                                     // every claim ended
      // The moment revocation ended D's work (the AUTHORISATION_LOST end of the claim it found): nothing of D after it.
      const ended = await p().testTaskClaim.findFirstOrThrow({ where: { coachId: D.id, endReason: 'AUTHORISATION_LOST' }, orderBy: { endedAt: 'desc' }, select: { endedAt: true } });
      expect(ended.endedAt!.getTime()).toBeGreaterThanOrEqual(revokedAt.getTime() - 5_000);
      expect(await p().testMarkDraftChange.count({ where: { actorId: D.id, createdAt: { gt: ended.endedAt! } } })).toBe(0);
      expect(await p().testTaskClaim.count({ where: { coachId: D.id, claimedAt: { gt: ended.endedAt! } } })).toBe(0);
      await p().markerAuthorization.create({ data: { coachId: D.id, disciplineId: maths, grantedById: ctx.ids.admin } });
      for (const q of await p().testQuestion.findMany({ where: { testId: id } })) await http().put(`${QM(id)}/questions/${q.id}/markers`).set(bearer(hm)).send({ add: [D.id] }).expect(200);
    }
  });

  it('20 coaches × 20 questions of one paper: all succeed; lock wait measured at L2–L3 in the database; no deadlock', async () => {
    const runs: Array<Record<string, number>> = [];
    for (let run = 0; run < 5; run++) {
      const { id, code } = await ready(20);
      const dl0 = Number((await p().$queryRaw<Array<{ d: bigint }>>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`)[0].d);
      const t0 = Date.now();
      const res = await Promise.all(coaches.map((c, i) => claim(c.token, code, `q${i + 1}`)));
      const total = Date.now() - t0;
      const dl1 = Number((await p().$queryRaw<Array<{ d: bigint }>>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`)[0].d);
      const holders = await p().testQuestionTask.findMany({ where: { submission: { testId: id } }, select: { holderId: true } });
      const openAssessments = await p().testQuestionAssessment.findMany({ where: { task: { submission: { testId: id } }, status: { in: ['DRAFT', 'RETURNED'] } }, select: { taskId: true } });
      runs.push({
        run, successfulClaims: res.filter((r) => r.status === 200).length, failedClaims: res.filter((r) => r.status !== 200).length,
        activeClaims: await p().testTaskClaim.count({ where: { task: { submission: { testId: id } }, endedAt: null } }),
        openAssessments: openAssessments.length, duplicateOpenAssessments: openAssessments.length - new Set(openAssessments.map((a) => a.taskId)).size,
        duplicateHolders: holders.length - new Set(holders.map((h) => h.holderId)).size, totalApiMs: total, deadlocks: dl1 - dl0,
      });
      for (const [i, c] of coaches.entries()) await http().post(`${MT}/${code}/q${i + 1}/release`).set(bearer(c.token)).send({}).expect(200);
    }
    // The design's lock wait: from just before L2 to just after L3, in 20 parallel transactions on one paper.
    const { id, submissionId } = await ready(20);
    const tasks = await p().testQuestionTask.findMany({ where: { submission: { testId: id } }, select: { id: true } });
    const waits = await Promise.all(tasks.map((t, i) => p().$transaction(async (tx) => {
      await lockCoaches(tx, [coaches[i].id]);
      const [a] = await tx.$queryRaw<Array<{ t: Date }>>`SELECT clock_timestamp() AS "t"`;
      await lockPapers(tx, [submissionId], 'NO KEY UPDATE');
      await lockTasks(tx, [t.id]);
      const b = await lockedNow(tx);
      await sleep(20);                                              // a short body, as a claim's
      return b.getTime() - a.t.getTime();
    }, { timeout: 60_000, maxWait: 60_000 })));
    const report = { runs, lockWaitMs: { max: Math.max(...waits), median: waits.sort((x, y) => x - y)[Math.floor(waits.length / 2)] } };
    console.log('QM_LOCK_REPORT', JSON.stringify(report)); qmReport('lock', report);
    for (const r of runs) expect(r).toMatchObject({ successfulClaims: 20, failedClaims: 0, activeClaims: 20, openAssessments: 20, duplicateOpenAssessments: 0, duplicateHolders: 0, deadlocks: 0 });
  }, 300_000);

  it('mixed load (claims, saves, submits, releases, reviews, expiry) on 5 papers: no deadlock, every invariant holds', async () => {
    const seconds = Number(process.env.QM_LOAD_SECONDS ?? 20);
    const tests: Array<{ id: string; code: string; submissionId: string }> = [];
    for (let i = 0; i < 5; i++) tests.push(await ready(4));   // fixtures one by one (parallel uploads are not under test)
    const dl0 = Number((await p().$queryRaw<Array<{ d: bigint }>>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`)[0].d);
    const end = Date.now() + seconds * 1000;
    let ops = 0, errors5xx = 0;
    const transport: string[] = [];
    await Promise.all(coaches.slice(10, 20).map(async (c, ci) => {
      while (Date.now() < end) try {
        const tst = tests[(ci + ops) % tests.length];
        const ref = `q${1 + ((ci + ops) % 4)}`;
        const r = await claim(c.token, tst.code, ref);
        if (r.status >= 500) errors5xx++;
        if (r.status === 200) {
          await http().put(`${MT}/${tst.code}/${ref}/marks`).set(bearer(c.token)).send({ marks: 1 });
          const s = ops % 3 === 0 ? await http().post(`${MT}/${tst.code}/${ref}/submit`).set(bearer(c.token)).send({ marks: 1 }) : await http().post(`${MT}/${tst.code}/${ref}/release`).set(bearer(c.token)).send({});
          if (s.status >= 500) errors5xx++;
          if (ops % 3 === 0 && s.status === 200) {
            const t = await p().testQuestionTask.findFirst({ where: { submission: { publicCode: tst.code }, question: { order: Number(ref.slice(1)) }, round: 'FIRST' } });
            const rv = await http().post(`${QM(tst.id)}/tasks/${t!.id}/return`).set(bearer(hm)).send({ reason: 'Load test return' });
            if (rv.status >= 500) errors5xx++;
          }
        }
        if (ops % 7 === 0) {
          // Expire some claims as time would: one row per statement (holding one lock at a time, so it joins no cycle).
          const live = await p().testQuestionTask.findMany({ where: { status: 'IN_PROGRESS' }, select: { id: true }, take: 3 });
          for (const l of live) await p().$executeRaw`UPDATE "TestQuestionTask" SET "lockExpiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${l.id} AND "status" = 'IN_PROGRESS'`;
        }
        ops++;
      } catch (e) {
        transport.push(String((e as Error).message ?? e));
        ops++;
      }
    }));
    if (transport.length) console.log('QM_LOAD_TRANSPORT_ERRORS', transport.length, JSON.stringify(transport.slice(0, 5)));
    const dl1 = Number((await p().$queryRaw<Array<{ d: bigint }>>`SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`)[0].d);
    const bad = await p().$queryRaw<Array<{ n: number }>>`
      SELECT (SELECT count(*) FROM (SELECT "taskId" FROM "TestTaskClaim" WHERE "endedAt" IS NULL GROUP BY "taskId" HAVING count(*) > 1) x)::int
           + (SELECT count(*) FROM (SELECT "taskId" FROM "TestQuestionAssessment" WHERE "status" IN ('DRAFT','RETURNED') GROUP BY "taskId" HAVING count(*) > 1) y)::int
           + (SELECT count(*) FROM "TestSubmission" s JOIN "Test" t ON t."id" = s."testId" WHERE t."markingMode" = 'QUESTION' AND s."status"::text <> question_paper_status(s."id") AND s."status" <> 'PUBLISHED')::int AS "n"`;
    console.log('QM_LOAD_REPORT', JSON.stringify({ seconds, operations: ops, errors5xx, deadlocks: dl1 - dl0, invariantViolations: bad[0].n })); qmReport('load', { seconds, operations: ops, errors5xx, transportErrors: transport.length, transportSamples: [...new Set(transport)].slice(0, 5), deadlocks: dl1 - dl0, invariantViolations: bad[0].n });
    expect({ errors5xx, deadlocks: dl1 - dl0, invariantViolations: bad[0].n }).toEqual({ errors5xx: 0, deadlocks: 0, invariantViolations: 0 });
  }, 600_000);

  /**
   * Regression (develop CI 2026-11-28, the mixed load above: "Paper …: status MARKING_IN_PROGRESS is not its projection
   * RETURNED" → 500 on a claim). A claim first ends the coach's own expired claims (on any paper), then, when the coach
   * already holds the requested question, answers "already mine". That early answer skipped the projection of the papers
   * whose questions it had just changed, so the commit-time paper invariant refused the transaction. Each paper changed
   * by a claim must be projected, whatever the claim answers.
   */
  describe('re-claiming a question I already hold while another of my claims has expired', () => {
    let n = 0;
    /** A coach of their own (marker of every question of tests made from now on), so no earlier claim counts. */
    const freshCoach = async () => {
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const username = `qml.reclaim${n++}`;
      const id = (await p().user.create({ data: { username, firstName: 'R', lastName: `${n}`, email: `${username}@test.local`, role: 'MENTOR', passwordHash: hash, activatedAt: new Date() } })).id;
      await p().markerAuthorization.create({ data: { coachId: id, disciplineId: maths, grantedById: ctx.ids.admin } });
      const coach = { id, token: await login(ctx, username) };
      coaches.push(coach);   // ready() makes every coach in the list a marker of the new test's questions
      return coach;
    };
    const expire = (taskId: string) => p().$executeRaw`UPDATE "TestQuestionTask" SET "lockExpiresAt" = clock_timestamp() - interval '1 second' WHERE "id" = ${taskId}`;
    const paperStatus = async (submissionId: string) => (await p().$queryRaw<Array<{ stored: string; projected: string }>>`
      SELECT "status"::text AS "stored", question_paper_status("id") AS "projected" FROM "TestSubmission" WHERE "id" = ${submissionId}`)[0];

    it('returned work (the CI case): the expired resumed claim goes back to RETURNED and its paper becomes RETURNED in the same transaction', async () => {
      const coach = await freshCoach();
      const held = await ready(1);       // paper 1: the question the coach holds and asks for again
      const other = await ready(1);      // paper 2: returned work the coach resumed, whose claim then expired
      const otherTask = await taskOf(other.id, 1);
      expect((await claim(coach.token, other.code, 'q1')).status).toBe(200);
      await http().post(`${MT}/${other.code}/q1/submit`).set(bearer(coach.token)).send({ marks: 1 }).expect(200);
      await http().post(`${QM(other.id)}/tasks/${otherTask.id}/return`).set(bearer(hm)).send({ reason: 'Regression: check again' }).expect(200);
      expect((await claim(coach.token, other.code, 'q1')).body.claim).toMatchObject({ method: 'RESUME', resumed: true });
      expect((await claim(coach.token, held.code, 'q1')).status).toBe(200);
      await expire(otherTask.id);
      expect(await paperStatus(other.submissionId)).toEqual({ stored: 'MARKING_IN_PROGRESS', projected: 'MARKING_IN_PROGRESS' });

      const again = await claim(coach.token, held.code, 'q1');
      expect([again.status, again.body.claim?.resumed]).toEqual([200, true]);   // "already mine", never a 500
      expect(await p().testQuestionTask.findUniqueOrThrow({ where: { id: otherTask.id }, select: { status: true, holderId: true, reservedForId: true } }))
        .toEqual({ status: 'RETURNED', holderId: null, reservedForId: coach.id });
      expect(await paperStatus(other.submissionId)).toEqual({ stored: 'RETURNED', projected: 'RETURNED' });
      expect(await p().testSubmissionStatusChange.count({ where: { submissionId: other.submissionId, fromStatus: 'MARKING_IN_PROGRESS', toStatus: 'RETURNED' } })).toBe(1);
      expect((await paperStatus(held.submissionId)).stored).toBe('MARKING_IN_PROGRESS');
    });

    it('pool work: the expired claim goes back to NOT_STARTED and its paper back to SUBMITTED', async () => {
      const coach = await freshCoach();
      const held = await ready(1);
      const other = await ready(1);
      const otherTask = await taskOf(other.id, 1);
      expect((await claim(coach.token, held.code, 'q1')).status).toBe(200);
      expect((await claim(coach.token, other.code, 'q1')).status).toBe(200);
      await expire(otherTask.id);

      const again = await claim(coach.token, held.code, 'q1');
      expect([again.status, again.body.claim?.resumed]).toEqual([200, true]);
      expect((await p().testQuestionTask.findUniqueOrThrow({ where: { id: otherTask.id } })).status).toBe('NOT_STARTED');
      expect(await paperStatus(other.submissionId)).toEqual({ stored: 'SUBMITTED', projected: 'SUBMITTED' });
      expect(await p().testTaskClaim.count({ where: { taskId: otherTask.id, coachId: coach.id, endReason: 'EXPIRED' } })).toBe(1);
    });
  });

  /**
   * Review 2026-11-28: heartbeat and save change no status, but their task update fires the commit-time paper invariant,
   * which reads the paper status and its projection in two statements. Without the paper lock, a review committing
   * between those reads made the heartbeat fail with a false "status … is not its projection …". They now hold the paper
   * FOR SHARE: a status change of the paper (a review's FOR UPDATE, a claim's NO KEY UPDATE) is waited for; another
   * coach's heartbeat or save (FOR SHARE) is not.
   */
  describe('heartbeat and save hold the paper FOR SHARE', () => {
    it('they wait for a review holding the paper, then succeed; a shared hold (another heartbeat) does not block them', async () => {
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const id = (await p().user.create({ data: { username: 'qml.share', firstName: 'S', lastName: 'H', email: 'qml.share@test.local', role: 'MENTOR', passwordHash: hash, activatedAt: new Date() } })).id;
      await p().markerAuthorization.create({ data: { coachId: id, disciplineId: maths, grantedById: ctx.ids.admin } });
      const coach = { id, token: await login(ctx, 'qml.share') };
      coaches.push(coach);
      const paper = await ready(2);
      expect((await claim(coach.token, paper.code, 'q1')).status).toBe(200);
      const heartbeat = () => http().post(`${MT}/${paper.code}/q1/heartbeat`).set(bearer(coach.token)).send({});
      const save = () => http().put(`${MT}/${paper.code}/q1/marks`).set(bearer(coach.token)).send({ marks: 1 });

      // A review holds the paper FOR UPDATE: both wait until it ends.
      const review = await client();
      await review.query('BEGIN');
      await review.query('SELECT 1 FROM "TestSubmission" WHERE "id" = $1 FOR UPDATE', [paper.submissionId]);
      const settled: string[] = [];
      const hb = heartbeat().then((r) => { settled.push('heartbeat'); return r; });
      const sv = save().then((r) => { settled.push('save'); return r; });
      await sleep(800);
      expect(settled).toEqual([]);
      await review.query('COMMIT');
      await review.end();
      expect([(await hb).status, (await sv).status]).toEqual([200, 200]);

      // Another coach's heartbeat holds it FOR SHARE: no wait.
      const other = await client();
      await other.query('BEGIN');
      await other.query('SELECT 1 FROM "TestSubmission" WHERE "id" = $1 FOR SHARE', [paper.submissionId]);
      const t0 = Date.now();
      expect((await heartbeat()).status).toBe(200);
      expect((await save()).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(5_000);
      await other.query('COMMIT');
      await other.end();
      await http().post(`${MT}/${paper.code}/q1/release`).set(bearer(coach.token)).send({}).expect(200);
    });
  });
});
