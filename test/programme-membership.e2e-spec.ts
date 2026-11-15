/**
 * P1-07 — Mathematics programme membership: the M3 backfill (run from the real
 * migration file against seeded data), its rollback files, the K6 creation
 * hooks, the read-only scope helpers, and that membership changes no access.
 *
 * CI's fresh database applies M3 as a no-op (K3: no students or coaches yet), so
 * these tests execute the migration SQL themselves. Destructive checks run inside
 * a transaction that is always rolled back, so the fixture data stays intact.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import pg from 'pg';

import { AccessService } from '../src/common/access/access.service.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const ROOT = join(__dirname, '..');
const M3_SQL = readFileSync(join(ROOT, 'prisma/migrations/20261121000200_backfill_programme_membership/migration.sql'), 'utf8');
const M3_ROLLBACK = readFileSync(join(ROOT, 'docs/migrations/20261121000200_backfill_programme_membership.rollback.sql'), 'utf8');
const M2_ROLLBACK = readFileSync(join(ROOT, 'docs/migrations/20261121000100_programme_membership.rollback.sql'), 'utf8');
/** A rollback file's statements without its own BEGIN/COMMIT (the test owns the transaction). */
const statements = (sql: string) => sql.split('\n').filter((l) => !l.startsWith('--')).join('\n')
  .split(';').map((s) => s.trim()).filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));

/** Thrown to roll a transaction back after its assertions passed. */
class Rollback extends Error {}

describe('Programme membership (P1-07)', () => {
  let ctx: TestContext;
  let admin: string;
  let mathsId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;

  beforeAll(async () => {
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    mathsId = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
  });
  afterAll(async () => { await ctx?.app.close(); });

  /** Run fn in a transaction that is always rolled back. */
  async function inRolledBackTx(fn: (tx: any) => Promise<void>) {
    await expect(p().$transaction(async (tx) => { await fn(tx); throw new Rollback(); }, { timeout: 30_000 }))
      .rejects.toBeInstanceOf(Rollback);
  }
  const runM3 = (tx: any) => tx.$executeRawUnsafe(M3_SQL);
  const memberships = (tx: any) => tx.programmeMembership.findMany({
    orderBy: [{ userId: 'asc' }, { disciplineId: 'asc' }],
    select: { id: true, userId: true, disciplineId: true, source: true, isActive: true, addedById: true, endedAt: true },
  });

  describe('backfill (M3)', () => {
    it('K3: with no student or coach accounts it is a no-op — no error, no row, no audit entry', async () => {
      await inRolledBackTx(async (tx) => {
        await tx.programmeMembership.deleteMany({});
        await tx.user.updateMany({ where: { role: { in: ['STUDENT', 'MENTOR'] } }, data: { role: 'ADMIN' } });
        await tx.discipline.create({ data: { code: 'PHYSICS', name: 'Physics' } });   // would fail the precondition
        await runM3(tx);
        expect(await tx.programmeMembership.count()).toBe(0);
        expect(await tx.auditLog.count({ where: { action: 'PROGRAMME_MEMBERSHIP_BACKFILL' } })).toBe(0);
      });
    });

    it.each([
      ['a second discipline exists', async (tx: any) => { await tx.discipline.create({ data: { code: 'PHYSICS', name: 'Physics' } }); }],
      ['the only discipline is not MATHEMATICS', async (tx: any) => { await tx.discipline.update({ where: { id: mathsId }, data: { code: 'MATHS' } }); }],
    ])('precondition: aborts with an explicit error when %s, and writes nothing', async (_, setup) => {
      const before = await memberships(p());
      await p().programmeMembership.deleteMany({ where: { source: 'BACKFILL' } });
      try {
        let message = '';
        await expect(p().$transaction(async (tx) => {
          await setup(tx);
          try { await runM3(tx); } catch (e) { message = String((e as Error).message); throw e; }
        })).rejects.toBeDefined();
        expect(message).toMatch(/Programme membership backfill aborted: expected exactly one discipline \(MATHEMATICS\)/);
        expect(await p().programmeMembership.count({ where: { source: 'BACKFILL' } })).toBe(0);
        expect(await p().discipline.count()).toBe(1);   // the setup was rolled back too
      } finally {
        // restore the fixture memberships exactly
        await p().programmeMembership.deleteMany({});
        await p().programmeMembership.createMany({ data: before.map((m: any) => ({ ...m, source: m.source })) });
      }
      expect(await memberships(p())).toEqual(before);
    });

    it('reconciliation: every student → Mathematics; every coach → the disciplines of their assignments (active or ended) or Mathematics; administrators none; existing ids untouched', async () => {
      await inRolledBackTx(async (tx) => {
        await tx.programmeMembership.deleteMany({});
        const usersBefore = await tx.user.findMany({ orderBy: { id: 'asc' }, select: { id: true, role: true, updatedAt: true } });
        // K4: accounts of any status count.
        const hash = (await tx.user.findUniqueOrThrow({ where: { username: 'admin' } })).passwordHash;
        const division = (await tx.user.findUniqueOrThrow({ where: { username: 'student.j' } }));
        const mk = (username: string, role: 'STUDENT' | 'MENTOR', extra: object = {}) => tx.user.create({ data: {
          username, firstName: username, lastName: 'K', email: `${username}@test.local`, role, passwordHash: hash,
          ...(role === 'STUDENT' && { gradeLevel: 'S2', divisionId: division.divisionId, schoolId: division.schoolId }), ...extra,
        } });
        const suspended   = await mk('k4.suspended', 'STUDENT', { isActive: false, activatedAt: new Date() });
        const unapproved  = await mk('k4.unapproved', 'STUDENT', { isApproved: false, activatedAt: new Date() });
        const notActive   = await mk('k4.notactivated', 'STUDENT', { activatedAt: null });
        const coachEnded  = await mk('k5.ended', 'MENTOR', { activatedAt: new Date() });
        const coachNone   = await mk('k5.none', 'MENTOR', { activatedAt: new Date() });
        await tx.mentorAssignment.create({ data: { mentorId: coachEnded.id, courseId: ctx.ids.geometry, divisionId: ctx.ids.senior, isActive: false } });
        // A former coach (now ADMIN) with an old assignment gets nothing (role decides, not leftovers).
        const former = await mk('former.coach', 'MENTOR', { activatedAt: new Date() });
        await tx.mentorAssignment.create({ data: { mentorId: former.id, courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, isActive: false } });
        await tx.user.update({ where: { id: former.id }, data: { role: 'ADMIN' } });

        await runM3(tx);

        const rows = await memberships(tx);
        const students = await tx.user.findMany({ where: { role: 'STUDENT' }, select: { id: true } });
        const coaches  = await tx.user.findMany({ where: { role: 'MENTOR' }, select: { id: true } });
        const admins   = await tx.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
        // counts: students + Σ coaches (distinct disciplines of assignments, or 1)
        expect(rows).toHaveLength(students.length + coaches.length);   // single discipline: one row each
        for (const s of [...students, ...coaches]) {
          expect([s.id, rows.filter((r: any) => r.userId === s.id).map((r: any) => r.disciplineId)]).toEqual([s.id, [mathsId]]);
        }
        for (const a of admins) expect(rows.some((r: any) => r.userId === a.id)).toBe(false);
        for (const u of [suspended, unapproved, notActive, coachEnded, coachNone]) expect(rows.some((r: any) => r.userId === u.id)).toBe(true);
        expect(rows.some((r: any) => r.userId === former.id)).toBe(false);
        expect(rows.every((r: any) => r.source === 'BACKFILL' && r.addedById === null && r.isActive && r.endedAt === null)).toBe(true);
        expect(new Set(rows.map((r: any) => `${r.userId}/${r.disciplineId}`)).size).toBe(rows.length);
        // One summary audit row, counts only.
        const audit = await tx.auditLog.findMany({ where: { action: 'PROGRAMME_MEMBERSHIP_BACKFILL' } });
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ actorId: null, entity: 'ProgrammeMembership',
          metadata: { studentMemberships: students.length, coachMemberships: coaches.length, disciplineId: mathsId } });
        // Existing rows untouched: users keep their ids, roles and updatedAt.
        const usersAfter = await tx.user.findMany({ where: { id: { in: usersBefore.map((u: any) => u.id) } }, orderBy: { id: 'asc' }, select: { id: true, role: true, updatedAt: true } });
        expect(usersAfter).toEqual(usersBefore);
      });
    });

    it('idempotent: running it again adds nothing and changes no id; no second audit row', async () => {
      await inRolledBackTx(async (tx) => {
        await tx.programmeMembership.deleteMany({});
        await runM3(tx);
        const first = await memberships(tx);
        await runM3(tx);
        expect(await memberships(tx)).toEqual(first);
        expect(await tx.auditLog.count({ where: { action: 'PROGRAMME_MEMBERSHIP_BACKFILL' } })).toBe(1);
      });
    });

    it('existing memberships are kept as they are: no duplicate, a MANUAL row stays MANUAL, an ended one is not revived', async () => {
      await inRolledBackTx(async (tx) => {
        await tx.programmeMembership.deleteMany({});
        await tx.programmeMembership.create({ data: { userId: ctx.ids.studentJunior, disciplineId: mathsId, source: 'MANUAL', addedById: ctx.ids.admin } });
        await tx.programmeMembership.create({ data: { userId: ctx.ids.mentorSenior, disciplineId: mathsId, source: 'MANUAL', isActive: false, endedAt: new Date(), endedById: ctx.ids.admin } });
        const kept = await memberships(tx);
        await runM3(tx);
        const after = await memberships(tx);
        for (const k of kept) expect(after.find((a: any) => a.id === k.id)).toEqual(k);
        expect(after.filter((a: any) => a.userId === ctx.ids.studentJunior)).toHaveLength(1);
        expect(after.filter((a: any) => a.userId === ctx.ids.mentorSenior)).toHaveLength(1);
      });
    });

    it('invalid records are refused by the database: unknown user or programme, duplicate pair, unknown source', async () => {
      const bad = [
        p().programmeMembership.create({ data: { userId: '00000000-0000-0000-0000-000000000000', disciplineId: mathsId, source: 'MANUAL' } }),
        p().programmeMembership.create({ data: { userId: ctx.ids.admin, disciplineId: '00000000-0000-0000-0000-000000000000', source: 'MANUAL' } }),
        p().programmeMembership.create({ data: { userId: ctx.ids.studentJunior, disciplineId: mathsId, source: 'MANUAL' } }),   // fixture already has it
        p().$executeRawUnsafe(`INSERT INTO "ProgrammeMembership" ("id","userId","disciplineId","source") VALUES ('x', '${ctx.ids.admin}', '${mathsId}', 'IMPORTED')`),
      ];
      for (const b of bad) await expect(b).rejects.toBeDefined();
      // A programme with members cannot be deleted (Restrict).
      await expect(p().discipline.delete({ where: { id: mathsId } })).rejects.toBeDefined();
    });

    it('failure part-way rolls the whole backfill back (one transaction)', async () => {
      await p().programmeMembership.deleteMany({ where: { source: 'BACKFILL' } });
      try {
        await expect(p().$transaction(async (tx) => {
          await runM3(tx);
          expect(await tx.programmeMembership.count()).toBeGreaterThan(0);
          await tx.$executeRawUnsafe('SELECT 1/0');   // a later failure
        })).rejects.toBeDefined();
        expect(await p().programmeMembership.count({ where: { source: 'BACKFILL' } })).toBe(0);
        expect(await p().auditLog.count({ where: { action: 'PROGRAMME_MEMBERSHIP_BACKFILL' } })).toBe(0);
      } finally {
        await p().$transaction(async (tx) => { await runM3(tx); });
        await p().auditLog.count();   // the restoring run writes its own audit row (append-only log)
      }
      expect(await p().programmeMembership.count({ where: { source: 'BACKFILL' } })).toBe(6);
    });
  });

  describe('rollback files (run statement by statement in a transaction that is then rolled back)', () => {
    const client = async () => { const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect(); return c; };

    it('M3 rollback removes BACKFILL rows only — MANUAL rows stay — and re-applying gives the same reconciliation', async () => {
      const c = await client();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO "ProgrammeMembership" ("id","userId","disciplineId","source","addedById") VALUES (gen_random_uuid()::text, $1, $2, 'MANUAL', $1)`, [ctx.ids.admin, mathsId]);
        const before = (await c.query(`SELECT "userId","source" FROM "ProgrammeMembership" ORDER BY "userId"`)).rows;
        for (const s of statements(M3_ROLLBACK)) await c.query(s);
        const after = (await c.query(`SELECT "userId","source" FROM "ProgrammeMembership"`)).rows;
        expect(after).toEqual([{ userId: ctx.ids.admin, source: 'MANUAL' }]);
        expect((await c.query(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = '20261121000200_backfill_programme_membership'`)).rows[0].n).toBe(0);
        await c.query(M3_SQL);   // re-apply
        const again = (await c.query(`SELECT "userId","source" FROM "ProgrammeMembership" ORDER BY "userId"`)).rows;
        expect(again).toEqual(before);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      expect(await p().programmeMembership.count()).toBe(6);   // nothing persisted
    });

    it('M2 rollback drops only the table and its enum', async () => {
      const c = await client();
      try {
        await c.query('BEGIN');
        const tablesBefore = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
        for (const s of statements(M3_ROLLBACK)) await c.query(s);
        for (const s of statements(M2_ROLLBACK)) await c.query(s);
        const tablesAfter = (await c.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`)).rows.map((r) => r.tablename);
        expect(tablesBefore.filter((t) => !tablesAfter.includes(t))).toEqual(['ProgrammeMembership']);
        expect((await c.query(`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'MembershipSource'`)).rows[0].n).toBe(0);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
      expect(await p().programmeMembership.count()).toBe(6);
    });
  });

  describe('new accounts (K6): a MANUAL Mathematics membership in the same transaction', () => {
    const membershipOf = (username: string) => p().programmeMembership.findMany({
      where: { user: { username } }, select: { disciplineId: true, source: true, addedById: true, isActive: true },
    });

    it('student self-registration (no actor)', async () => {
      await http().post('/api/v1/auth/register/student').send({
        firstName: 'Reg', lastName: 'Student', username: 'k6.reg', email: 'k6.reg@test.local', password: 'Secret123',
        gradeLevel: 'S2', schoolName: 'Test School', schoolLocation: 'Kigali', homeLocation: 'Kigali',
      }).expect(201);
      expect(await membershipOf('k6.reg')).toEqual([{ disciplineId: mathsId, source: 'MANUAL', addedById: null, isActive: true }]);
    });

    it('administrator creates a student and a coach; an administrator account gets none', async () => {
      for (const [username, role, extra] of [['k6.s', 'STUDENT', { gradeLevel: 'S3' }], ['k6.c', 'MENTOR', {}], ['k6.a', 'ADMIN', {}]] as const) {
        await http().post('/api/v1/admin/users').set(bearer(admin)).send({
          firstName: 'K6', lastName: role, username, email: `${username}@test.local`, password: 'Str0ng!Passw0rd', role, ...extra,
        }).expect(201);
      }
      expect(await membershipOf('k6.s')).toEqual([{ disciplineId: mathsId, source: 'MANUAL', addedById: ctx.ids.admin, isActive: true }]);
      expect(await membershipOf('k6.c')).toEqual([{ disciplineId: mathsId, source: 'MANUAL', addedById: ctx.ids.admin, isActive: true }]);
      expect(await membershipOf('k6.a')).toEqual([]);
    });

    it('invitation and CSV import', async () => {
      await http().post('/api/v1/admin/users/invite').set(bearer(admin))
        .send({ firstName: 'K6', lastName: 'Invite', username: 'k6.inv', email: 'k6.inv@test.local', role: 'MENTOR' }).expect(201);
      const csv = ['firstName,lastName,email,role,gradeLevel', 'K6,Csv,k6.csv@test.local,STUDENT,S1'].join('\r\n');
      const res = await http().post('/api/v1/admin/users/import').set(bearer(admin))
        .attach('file', Buffer.from(csv, 'utf8'), { filename: 'u.csv', contentType: 'text/csv' }).expect(200);
      expect(res.body.created).toBe(1);
      expect(await membershipOf('k6.inv')).toEqual([{ disciplineId: mathsId, source: 'MANUAL', addedById: ctx.ids.admin, isActive: true }]);
      expect(await p().programmeMembership.count({ where: { user: { email: 'k6.csv@test.local' }, disciplineId: mathsId, source: 'MANUAL' } })).toBe(1);
    });

    it('approved coach application', async () => {
      const apply = await http().post('/api/v1/mentor-requests')
        .send({ firstName: 'K6', lastName: 'Applicant', username: 'k6.app', email: 'k6.app@test.local', password: 'Mentor123' }).expect(201);
      expect(await membershipOf('k6.app')).toEqual([]);   // no account yet
      await http().patch(`/api/v1/mentor-requests/${apply.body.id}/approve`).set(bearer(admin)).expect(200);
      expect(await membershipOf('k6.app')).toEqual([{ disciplineId: mathsId, source: 'MANUAL', addedById: ctx.ids.admin, isActive: true }]);
    });

    it('with more than one programme, new accounts get none (choosing one is later work)', async () => {
      const physics = await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics' } });
      try {
        await http().post('/api/v1/admin/users').set(bearer(admin)).send({
          firstName: 'K6', lastName: 'Two', username: 'k6.two', email: 'k6.two@test.local', password: 'Str0ng!Passw0rd', role: 'MENTOR',
        }).expect(201);
        expect(await membershipOf('k6.two')).toEqual([]);
      } finally {
        await p().discipline.delete({ where: { id: physics.id } });
      }
    });
  });

  describe('scope helpers (read-only, for Head Coach / Teacher scope later)', () => {
    it('active members and courses of the requested programmes only; administrators never; ended memberships excluded', async () => {
      const access = ctx.app.get(AccessService);
      const physics = await p().discipline.create({ data: { code: 'PHYSICS', name: 'Physics' } });
      const mechanics = await p().course.create({ data: { code: 'MECH', title: 'Mechanics', description: 'Test-only course.', disciplineId: physics.id } });
      try {
        // mentor.j teaches in both programmes; student.s is only in Physics after leaving Mathematics.
        await p().programmeMembership.create({ data: { userId: ctx.ids.mentorJunior, disciplineId: physics.id, source: 'MANUAL' } });
        await p().programmeMembership.update({ where: { userId_disciplineId: { userId: ctx.ids.studentSenior, disciplineId: mathsId } }, data: { isActive: false, endedAt: new Date() } });
        await p().programmeMembership.create({ data: { userId: ctx.ids.studentSenior, disciplineId: physics.id, source: 'MANUAL' } });

        expect(await access.programmesOf(ctx.ids.mentorJunior)).toEqual([mathsId, physics.id].sort());
        expect(await access.programmesOf(ctx.ids.studentSenior)).toEqual([physics.id]);
        expect(await access.isProgrammeMember(ctx.ids.studentSenior, mathsId)).toBe(false);
        expect(await access.isProgrammeMember(ctx.ids.mentorJunior, physics.id)).toBe(true);
        expect(await access.programmesOf(ctx.ids.admin)).toEqual([]);

        const mathsMembers = (await p().user.findMany({ where: access.programmeMembersFilter([mathsId]), select: { id: true } })).map((u) => u.id);
        expect(mathsMembers).toContain(ctx.ids.mentorJunior);
        expect(mathsMembers).not.toContain(ctx.ids.studentSenior);
        expect(mathsMembers).not.toContain(ctx.ids.admin);
        const physicsMembers = (await p().user.findMany({ where: access.programmeMembersFilter([physics.id]), select: { id: true } })).map((u) => u.id).sort();
        expect(physicsMembers).toEqual([ctx.ids.mentorJunior, ctx.ids.studentSenior].sort());
        expect(await p().user.count({ where: access.programmeMembersFilter([]) })).toBe(0);

        const physicsCourses = (await p().course.findMany({ where: access.programmeCoursesFilter([physics.id]), select: { id: true } })).map((c) => c.id);
        expect(physicsCourses).toEqual([mechanics.id]);
        expect(await p().course.count({ where: access.programmeCoursesFilter([]) })).toBe(0);
      } finally {
        await p().programmeMembership.deleteMany({ where: { disciplineId: physics.id } });
        await p().programmeMembership.update({ where: { userId_disciplineId: { userId: ctx.ids.studentSenior, disciplineId: mathsId } }, data: { isActive: true, endedAt: null } });
        await p().course.delete({ where: { id: mechanics.id } });
        await p().discipline.delete({ where: { id: physics.id } });
      }
    });
  });

  describe('membership changes no existing access', () => {
    it('student and coach responses are identical with and without memberships', async () => {
      const student = await login(ctx, 'student.j');
      const coach   = await login(ctx, 'mentor.j');
      const probe = async () => {
        const out: unknown[] = [];
        for (const make of [
          () => http().get("/api/v1/courses").set(bearer(student)),
          () => http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(student)),
          () => http().get("/api/v1/me/courses").set(bearer(student)),
          () => http().get("/api/v1/me/permissions").set(bearer(student)),
          () => http().get("/api/v1/courses").set(bearer(coach)),
          () => http().get("/api/v1/me/teaching").set(bearer(coach)),
          () => http().get(`/api/v1/courses/${ctx.ids.algebra}`).set(bearer(coach)),
          () => http().get("/api/v1/me/permissions").set(bearer(coach)),
        ]) {
          const r = await make();
          // lastOpenedAt is refreshed by the probe's own course view; every other field must match.
          out.push([r.status, JSON.parse(JSON.stringify(r.body, (k, v) => (k === 'lastOpenedAt' ? undefined : v)))]);
        }
        return out;
      };
      await probe();   // warm-up: a first course view records the student's progress (UNROLLED → ROLLED)
      const withMemberships = await probe();
      const saved = await memberships(p());
      await p().programmeMembership.deleteMany({});
      try {
        const without = await probe();
        for (let i = 0; i < withMemberships.length; i++) expect([i, without[i]]).toEqual([i, withMemberships[i]]);
      } finally {
        await p().programmeMembership.createMany({ data: saved });
      }
    });
  });
});
