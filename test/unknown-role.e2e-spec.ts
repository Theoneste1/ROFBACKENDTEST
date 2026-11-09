/**
 * Unknown / unsupported caller roles — P1-03 (plan v2.1 §5.2–5.3).
 *
 * The database Role enum cannot hold an unknown value, and nothing here tries
 * to store one. Instead the signed-in caller (AuthUser — the object JwtStrategy
 * normally builds from the user row and controllers pass to services) is built
 * in memory with role 'UNKNOWN_ROLE' and handed to the REAL controller handlers
 * of the booted test application (real services, AccessService, Prisma, test
 * database). That exercises everything after the guards; the guards themselves
 * are pinned by the P1-02 guard-decision baseline.
 *
 * Callers:
 *   former coach   — id of the seeded coach mentor.j (active MentorAssignment on
 *                    Algebra × Junior); only the in-memory role is overridden.
 *   former student — id of student.j, with a division on the caller.
 *   fresh          — an id that does not exist in the database.
 *
 * UR-01…UR-52 cover every REGISTERED @Authenticated route (the two dormant
 * Study Groups handlers are covered by the P1-02 declaration test only).
 */
import { HttpException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { randomUUID } from 'crypto';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

import { createTestApp, login, bearer, inDays, PDF, waitForEvents, type TestContext } from './helpers.js';
import type { AuthUser } from '../src/common/auth-user.js';
import type { Role } from '../src/generated/prisma/client.js';
import { IS_AUTHENTICATED_KEY } from '../src/common/decorators/authenticated.decorator.js';
import { AcademicYearsController } from '../src/academic-years/academic-years.controller.js';
import { AssignmentsController } from '../src/assignments/assignments.controller.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { CoursesController, DisciplinesController } from '../src/courses/courses.controller.js';
import { DiscussionsController } from '../src/discussions/discussions.controller.js';
import { LeaderboardController } from '../src/leaderboard/leaderboard.controller.js';
import { NotificationsController } from '../src/notifications/notifications.controller.js';
import { SubmissionsController } from '../src/submissions/submissions.controller.js';
import { MeController } from '../src/users/users.controller.js';

// ── Outcomes and fakes ───────────────────────────────────────────────────────

type Outcome = { ok: true; value: unknown } | { ok: false; status: number; code?: string };

async function outcome(fn: () => unknown): Promise<Outcome> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof HttpException) {
      const body = err.getResponse() as { code?: string } | string;
      return { ok: false, status: err.getStatus(), code: typeof body === 'object' ? body.code : undefined };
    }
    throw err;
  }
}

/** A stand-in Express Response that records whether anything touched it. */
function fakeResponse() {
  const state = { touched: false };
  const res = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined;              // not a promise
      if (prop === 'headersSent') return false;
      state.touched = true;
      return () => res;
    },
  });
  return { res: res as never, state };
}

const unsupported = (base: { id: string; username: string; divisionId?: string | null }): AuthUser => ({
  id: base.id,
  username: base.username,
  role: 'UNKNOWN_ROLE' as unknown as Role,   // compile-time cast only; never persisted
  divisionId: base.divisionId ?? null,
  gradeLevel: null,
});

// ── Registered @Authenticated routes, derived from the code and routes.json ──

const ROOT = resolve(__dirname, '..');
const HTTP = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
const joinPath = (...p: Array<string | undefined>) => '/' + p.flatMap((x) => (x ?? '').split('/')).filter(Boolean).join('/');

async function registeredAuthenticatedRoutes(): Promise<string[]> {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === 'generated' ? [] : files(p);
    return p.endsWith('.controller.ts') ? [p] : [];
  });
  const prefix = /export const API_PREFIX = '([^']+)'/.exec(readFileSync(join(ROOT, 'src/main.ts'), 'utf8'))![1];
  const registered = new Set((JSON.parse(readFileSync(join(ROOT, 'docs/api/routes.json'), 'utf8')) as Array<{ method: string; path: string }>)
    .map((r) => `${r.method} ${r.path.replace(/\{(\w+)\}/g, ':$1')}`));
  const out: string[] = [];
  for (const file of files(join(ROOT, 'src'))) {
    for (const value of Object.values((await import(file)) as Record<string, unknown>)) {
      if (typeof value !== 'function') continue;
      const base: unknown = Reflect.getMetadata(PATH_METADATA, value);
      if (base === undefined) continue;
      for (const name of Object.getOwnPropertyNames(value.prototype)) {
        const h = (value.prototype as Record<string, unknown>)[name];
        if (name === 'constructor' || typeof h !== 'function' || Reflect.getMetadata(METHOD_METADATA, h) === undefined) continue;
        if (Reflect.getMetadata(IS_AUTHENTICATED_KEY, h) !== true) continue;
        const sub: unknown = Reflect.getMetadata(PATH_METADATA, h);
        const route = `${HTTP[Reflect.getMetadata(METHOD_METADATA, h)]} ${joinPath(prefix, Array.isArray(base) ? base[0] : (base as string), Array.isArray(sub) ? sub[0] : (sub as string))}`;
        if (registered.has(route)) out.push(route);
      }
    }
  }
  return out.sort();
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

describe('unknown / unsupported caller roles (P1-03)', () => {
  let ctx: TestContext;
  let c: {
    years: AcademicYearsController; assignments: AssignmentsController; auth: AuthController; courses: CoursesController;
    disciplines: DisciplinesController; discussions: DiscussionsController; leaderboard: LeaderboardController;
    notifications: NotificationsController; submissions: SubmissionsController; me: MeController;
  };
  const f = {} as {
    assignmentId: string; resourceId: string; resourceAttachmentId: string; courseThreadId: string; courseCommentId: string;
    assignmentThreadId: string; submissionId: string; submissionAttachmentId: string; notificationId: string; draftCourseId: string;
  };
  let formerCoach: AuthUser, formerStudent: AuthUser, fresh: AuthUser;
  let knownCoach: AuthUser, knownStudent: AuthUser, knownAdmin: AuthUser;
  let assignmentsBefore: number;

  beforeAll(async () => {
    ctx = await createTestApp();
    c = {
      years: ctx.app.get(AcademicYearsController), assignments: ctx.app.get(AssignmentsController), auth: ctx.app.get(AuthController),
      courses: ctx.app.get(CoursesController), disciplines: ctx.app.get(DisciplinesController), discussions: ctx.app.get(DiscussionsController),
      leaderboard: ctx.app.get(LeaderboardController), notifications: ctx.app.get(NotificationsController),
      submissions: ctx.app.get(SubmissionsController), me: ctx.app.get(MeController),
    };
    const [mentorJ, studentJ] = await Promise.all(['mentor.j', 'student.j'].map((u) => login(ctx, u)));

    // Real users as AuthUser, built from their database rows (as JwtStrategy does).
    const asAuth = async (id: string): Promise<AuthUser> => {
      const u = await ctx.prisma.user.findUniqueOrThrow({ where: { id }, select: { id: true, username: true, role: true, divisionId: true, gradeLevel: true } });
      return { ...u };
    };
    [knownCoach, knownStudent, knownAdmin] = await Promise.all([asAuth(ctx.ids.mentorJunior), asAuth(ctx.ids.studentJunior), asAuth(ctx.ids.admin)]);
    formerCoach = unsupported(knownCoach);
    formerStudent = unsupported(knownStudent);
    fresh = unsupported({ id: randomUUID(), username: 'nobody' });

    // Precondition of the former-coach case: active coach assignments on record, stored role MENTOR.
    assignmentsBefore = await ctx.prisma.mentorAssignment.count({ where: { mentorId: ctx.ids.mentorJunior, isActive: true } });
    expect(assignmentsBefore).toBeGreaterThan(0);
    expect(knownCoach.role).toBe('MENTOR');

    // Existing records, so that every 404 proves refusal, not absence.
    const a = await ctx.prisma.assignment.create({ data: {
      title: 'UR assignment', instructions: 'Solve every problem.', deadline: new Date(inDays(5)), points: 10, maximumMarks: 10,
      courseId: ctx.ids.algebra, divisionId: ctx.ids.junior, academicYearId: ctx.ids.year,
      createdById: ctx.ids.mentorJunior, status: 'PUBLISHED', publishedAt: new Date(),
    } });
    f.assignmentId = a.id;
    const r = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/resources`).set(bearer(mentorJ))
      .field('divisionId', ctx.ids.junior).field('type', 'NOTE').field('title', 'UR notes').attach('file', PDF, 'notes.pdf').expect(201);
    f.resourceId = r.body.id;
    f.resourceAttachmentId = r.body.attachments[0].id;
    const t = await ctx.http().post(`/api/v1/courses/${ctx.ids.algebra}/threads`).set(bearer(studentJ))
      .send({ title: 'UR course thread', content: 'A question about the notes.' }).expect(201);
    f.courseThreadId = t.body.id;
    const cm = await ctx.http().post(`/api/v1/threads/${f.courseThreadId}/comments`).set(bearer(studentJ))
      .send({ content: 'A first comment.' }).expect(201);
    f.courseCommentId = cm.body.id;
    const at = await ctx.http().post(`/api/v1/assignments/${f.assignmentId}/threads`).set(bearer(studentJ))
      .send({ title: 'UR assignment thread', content: 'A question about problem 1.' }).expect(201);
    f.assignmentThreadId = at.body.id;
    const s = await ctx.http().post('/api/v1/submissions').set(bearer(studentJ))
      .field('assignmentId', f.assignmentId).attach('files', PDF, 'work.pdf').expect(201);
    f.submissionId = s.body.id;
    const sub = await ctx.prisma.submission.findUniqueOrThrow({ where: { id: f.submissionId }, include: { revisions: { include: { attachments: true } } } });
    f.submissionAttachmentId = sub.revisions[0].attachments[0].id;
    await waitForEvents();
    const note = await ctx.prisma.notification.findFirst({ where: { userId: ctx.ids.mentorJunior } })
      ?? await ctx.prisma.notification.create({ data: { userId: ctx.ids.mentorJunior, category: 'ASSIGNMENTS', type: 'ur.test', title: 'UR', body: 'UR' } });
    f.notificationId = note.id;
    const algebra = await ctx.prisma.course.findUniqueOrThrow({ where: { id: ctx.ids.algebra }, select: { disciplineId: true } });
    f.draftCourseId = (await ctx.prisma.course.create({ data: {
      disciplineId: algebra.disciplineId, code: 'UR-DRAFT', title: 'UR draft course', description: 'Not published.', status: 'DRAFT',
    } })).id;
  });

  afterAll(async () => {
    // No database role was changed: stored roles and the coach's assignments are as before.
    if (ctx) {
      const roles = await ctx.prisma.user.findMany({ where: { id: { in: [ctx.ids.mentorJunior, ctx.ids.studentJunior] } }, select: { id: true, role: true } });
      expect(Object.fromEntries(roles.map((u) => [u.id, u.role]))).toEqual({ [ctx.ids.mentorJunior]: 'MENTOR', [ctx.ids.studentJunior]: 'STUDENT' });
      expect(await ctx.prisma.mentorAssignment.count({ where: { mentorId: ctx.ids.mentorJunior, isActive: true } })).toBe(assignmentsBefore);
      await ctx.app.close();
    }
  });

  // ── The 52 registered @Authenticated routes ──────────────────────────────

  type Kind = '403' | '404' | 'same';
  interface Case { id: string; route: string; kind: Kind; run: (u: AuthUser, res: ReturnType<typeof fakeResponse>['res']) => unknown }
  const q = {} as never;
  const CASES: Case[] = [
    // role-dependent collections → 403 ROLE_NOT_SUPPORTED
    { id: 'UR-01', route: 'GET /api/v1/assignments', kind: '403', run: (u) => c.assignments.findAll(u, { page: 1, limit: 20 } as never) },
    { id: 'UR-02', route: 'GET /api/v1/courses', kind: '403', run: (u) => c.courses.findAll(u) },
    { id: 'UR-03', route: 'GET /api/v1/courses/:courseId/resources', kind: '403', run: (u) => c.courses.listResources(ctx.ids.algebra, { includeArchived: true } as never, u) },
    { id: 'UR-04', route: 'GET /api/v1/leaderboard', kind: '403', run: (u) => c.leaderboard.findGeneral(u, { divisionId: ctx.ids.junior, page: 1, limit: 20 } as never) },
    { id: 'UR-05', route: 'GET /api/v1/leaderboard/schools', kind: '403', run: (u) => c.leaderboard.findSchoolSummary(u, { divisionId: ctx.ids.junior, page: 1, limit: 20 } as never) },
    // specific records → 404
    { id: 'UR-06', route: 'GET /api/v1/assignments/:assignmentId/threads', kind: '404', run: (u) => c.discussions.listAssignmentThreads(f.assignmentId, q, u) },
    { id: 'UR-07', route: 'POST /api/v1/assignments/:assignmentId/threads', kind: '404', run: (u) => c.discussions.createAssignmentThread(f.assignmentId, { title: 'x', content: 'y' } as never, u) },
    { id: 'UR-08', route: 'GET /api/v1/assignments/:id', kind: '404', run: (u) => c.assignments.findOne(f.assignmentId, u) },
    { id: 'UR-09', route: 'GET /api/v1/assignments/:id/attachments/:attachmentId/file', kind: '404', run: (u, res) => c.assignments.downloadAttachment(f.assignmentId, randomUUID(), undefined, u, res) },
    { id: 'UR-10', route: 'GET /api/v1/assignments/:id/file', kind: '404', run: (u, res) => c.assignments.download(f.assignmentId, undefined, u, res) },
    { id: 'UR-11', route: 'DELETE /api/v1/comments/:id', kind: '404', run: (u) => c.discussions.removeComment(f.courseCommentId, {} as never, u) },
    { id: 'UR-12', route: 'PATCH /api/v1/comments/:id', kind: '404', run: (u) => c.discussions.updateComment(f.courseCommentId, { content: 'edited' } as never, u) },
    { id: 'UR-13', route: 'POST /api/v1/comments/:id/reactions', kind: '404', run: (u) => c.discussions.react(f.courseCommentId, { type: 'LIKE' } as never, u) },
    { id: 'UR-14', route: 'GET /api/v1/comments/:id/replies', kind: '404', run: (u) => c.discussions.listReplies(f.courseCommentId, q, u) },
    { id: 'UR-15', route: 'POST /api/v1/comments/:id/report', kind: '404', run: (u) => c.discussions.reportComment(f.courseCommentId, { reason: 'spam' } as never, u) },
    { id: 'UR-16', route: 'GET /api/v1/courses/:courseId/resources/:resourceId', kind: '404', run: (u) => c.courses.getResource(ctx.ids.algebra, f.resourceId, u) },
    { id: 'UR-17', route: 'GET /api/v1/courses/:courseId/resources/:resourceId/attachments/:attachmentId/file', kind: '404', run: (u, res) => c.courses.serveAttachment(ctx.ids.algebra, f.resourceId, f.resourceAttachmentId, undefined, u, res) },
    { id: 'UR-18', route: 'GET /api/v1/courses/:courseId/resources/:resourceId/file', kind: '404', run: (u, res) => c.courses.serveResourceFile(ctx.ids.algebra, f.resourceId, undefined, u, res) },
    { id: 'UR-19', route: 'GET /api/v1/courses/:courseId/threads', kind: '404', run: async (u) => {
      const a = await outcome(() => c.discussions.listCourseThreads(ctx.ids.algebra, {} as never, u));
      const b = await outcome(() => c.discussions.listCourseThreads(ctx.ids.algebra, { divisionId: ctx.ids.junior } as never, u));
      expect(a).toEqual(b);            // with or without divisionId
      if (!a.ok) throw new HttpException('x', a.status);
      return a.value;
    } },
    { id: 'UR-20', route: 'POST /api/v1/courses/:courseId/threads', kind: '404', run: async (u) => {
      const a = await outcome(() => c.discussions.createCourseThread(ctx.ids.algebra, { title: 'x', content: 'y' } as never, u));
      const b = await outcome(() => c.discussions.createCourseThread(ctx.ids.algebra, { title: 'x', content: 'y', divisionId: ctx.ids.junior } as never, u));
      expect(a).toEqual(b);
      if (!a.ok) throw new HttpException('x', a.status);
      return a.value;
    } },
    { id: 'UR-21', route: 'GET /api/v1/courses/:id', kind: '404', run: (u) => c.courses.findOne(ctx.ids.algebra, u) },
    { id: 'UR-22', route: 'GET /api/v1/submissions/:id', kind: '404', run: (u) => c.submissions.findOne(f.submissionId, u) },
    { id: 'UR-23', route: 'GET /api/v1/submissions/:id/attachments/:attachmentId/file', kind: '404', run: (u, res) => c.submissions.attachmentFile(f.submissionId, f.submissionAttachmentId, u, res) },
    { id: 'UR-24', route: 'GET /api/v1/submissions/:id/feedback-file', kind: '404', run: (u, res) => c.submissions.feedbackFile(f.submissionId, u, res) },
    { id: 'UR-25', route: 'GET /api/v1/submissions/:id/feedback-files/:attachmentId', kind: '404', run: (u, res) => c.submissions.feedbackAttachment(f.submissionId, randomUUID(), u, res) },
    { id: 'UR-26', route: 'GET /api/v1/submissions/:id/file', kind: '404', run: (u, res) => c.submissions.file(f.submissionId, u, res) },
    { id: 'UR-27', route: 'GET /api/v1/submissions/:id/history', kind: '404', run: (u) => c.submissions.history(f.submissionId, u) },
    { id: 'UR-28', route: 'GET /api/v1/submissions/:id/revisions/:revisionNumber/file', kind: '404', run: (u, res) => c.submissions.revisionFile(f.submissionId, 1, u, res) },
    { id: 'UR-29', route: 'DELETE /api/v1/threads/:id', kind: '404', run: (u) => c.discussions.deleteThread(f.courseThreadId, {} as never, u) },
    { id: 'UR-30', route: 'GET /api/v1/threads/:id', kind: '404', run: (u) => c.discussions.getThread(f.courseThreadId, u) },
    { id: 'UR-31', route: 'PATCH /api/v1/threads/:id', kind: '404', run: (u) => c.discussions.updateThread(f.courseThreadId, { title: 'edited' } as never, u) },
    { id: 'UR-32', route: 'GET /api/v1/threads/:id/comments', kind: '404', run: (u) => c.discussions.listComments(f.courseThreadId, q, u) },
    { id: 'UR-33', route: 'POST /api/v1/threads/:id/comments', kind: '404', run: (u) => c.discussions.createComment(f.courseThreadId, { content: 'x' } as never, u) },
    { id: 'UR-34', route: 'POST /api/v1/threads/:id/report', kind: '404', run: (u) => c.discussions.reportThread(f.assignmentThreadId, { reason: 'spam' } as never, u) },
    // intentionally role-independent → same outcome as the same user with their real role
    { id: 'UR-35', route: 'GET /api/v1/academic-years', kind: 'same', run: () => c.years.list() },
    { id: 'UR-36', route: 'GET /api/v1/academic-years/current', kind: 'same', run: () => c.years.current() },
    { id: 'UR-37', route: 'POST /api/v1/auth/logout', kind: 'same', run: (u, res) => c.auth.logout(u, {} as never, { cookies: {} } as never, res) },
    { id: 'UR-38', route: 'POST /api/v1/auth/logout-all', kind: 'same', run: (u, res) => c.auth.logoutAll(u, res) },
    { id: 'UR-39', route: 'PATCH /api/v1/auth/password', kind: 'same', run: (u) => c.auth.changePassword(u, { currentPassword: 'not-the-password', newPassword: 'An0ther-Strong-Pass!' } as never) },
    { id: 'UR-40', route: 'GET /api/v1/disciplines', kind: 'same', run: () => c.disciplines.list() },
    { id: 'UR-41', route: 'GET /api/v1/me', kind: 'same', run: (u) => c.me.getMe(u) },
    { id: 'UR-42', route: 'PATCH /api/v1/me', kind: 'same', run: (u) => c.me.updateMe(u, {} as never) },
    { id: 'UR-43', route: 'GET /api/v1/me/notification-preferences', kind: 'same', run: (u) => c.notifications.preferences(u) },
    { id: 'UR-44', route: 'PUT /api/v1/me/notification-preferences', kind: 'same', run: (u) => c.notifications.updatePreferences(u, { preferences: [] } as never) },
    { id: 'UR-45', route: 'GET /api/v1/me/permissions', kind: 'same', run: (u) => c.me.permissions(u) },
    { id: 'UR-46', route: 'GET /api/v1/notifications', kind: 'same', run: (u) => c.notifications.list(u, { page: 1, limit: 20 } as never) },
    { id: 'UR-47', route: 'GET /api/v1/notifications/:id', kind: 'same', run: (u) => c.notifications.findOne(u, f.notificationId) },
    { id: 'UR-48', route: 'PATCH /api/v1/notifications/:id/read', kind: 'same', run: (u) => c.notifications.markRead(u, f.notificationId) },
    { id: 'UR-49', route: 'PATCH /api/v1/notifications/:id/unread', kind: 'same', run: (u) => c.notifications.markUnread(u, f.notificationId) },
    { id: 'UR-50', route: 'POST /api/v1/notifications/read', kind: 'same', run: (u) => c.notifications.markManyRead(u, { ids: [f.notificationId] } as never) },
    { id: 'UR-51', route: 'POST /api/v1/notifications/read-all', kind: 'same', run: (u) => c.notifications.markAllRead(u) },
    { id: 'UR-52', route: 'GET /api/v1/notifications/unread-count', kind: 'same', run: (u) => c.notifications.unreadCount(u) },
  ];
  /** Read-only role-independent cases: the unsupported caller must get exactly the same value. */
  const READ_ONLY = new Set(['UR-35', 'UR-36', 'UR-40', 'UR-41', 'UR-43', 'UR-46', 'UR-47', 'UR-52']);

  it('the UR cases cover exactly the registered @Authenticated routes (52), numbered UR-01…UR-52', async () => {
    expect(CASES.map((x) => x.id)).toEqual(Array.from({ length: 52 }, (_, i) => `UR-${String(i + 1).padStart(2, '0')}`));
    expect(CASES.map((x) => x.route).sort()).toEqual(await registeredAuthenticatedRoutes());
  });

  describe.each(CASES.filter((x) => x.kind !== 'same'))('$id $route', (cs) => {
    it.each([['former coach (active coach assignments)', () => formerCoach], ['former student', () => formerStudent], ['fresh account', () => fresh]])(
      'unsupported role — %s', async (_label, who) => {
        const { res, state } = fakeResponse();
        const got = await outcome(() => cs.run(who(), res));
        if (cs.kind === '403') expect(got).toEqual({ ok: false, status: 403, code: 'ROLE_NOT_SUPPORTED' });
        else expect(got).toMatchObject({ ok: false, status: 404 });
        expect(state.touched).toBe(false);          // nothing streamed or written
      },
    );
  });

  describe.each(CASES.filter((x) => x.kind === 'same'))('$id $route', (cs) => {
    it('unsupported role (former coach) — same outcome as the same user with their real role', async () => {
      const unknown = await outcome(() => cs.run(formerCoach, fakeResponse().res));
      const known = await outcome(() => cs.run(knownCoach, fakeResponse().res));
      if (cs.id === 'UR-45') {
        expect(unknown).toEqual({ ok: true, value: { role: 'UNKNOWN_ROLE', permissions: [] } });
        return;
      }
      expect(unknown.ok).toBe(known.ok);
      if (!unknown.ok && !known.ok) expect(unknown).toEqual(known);
      if (READ_ONLY.has(cs.id)) expect(unknown).toEqual(known);
    });
  });

  // ── Known roles: behaviour preserved where code was restructured (G1–G5) ──

  describe('known roles keep today\'s behaviour', () => {
    it('G1 course list: admin sees every course incl. DRAFT; coach only assigned courses; student only published', async () => {
      const ids = (rows: unknown) => (rows as Array<{ id: string; status?: string }>).map((r) => r.id);
      expect(ids(await c.courses.findAll(knownAdmin))).toContain(f.draftCourseId);
      const coach = ids(await c.courses.findAll(knownCoach));
      expect(coach).toContain(ctx.ids.algebra);
      expect(coach).not.toContain(f.draftCourseId);
      expect(ids(await c.courses.findAll(knownStudent))).not.toContain(f.draftCourseId);
    });

    it('G2 course detail: admin sees coach assignments; coach sees own divisions; student sees counts', async () => {
      expect(await c.courses.findOne(ctx.ids.algebra, knownAdmin)).toHaveProperty('mentorAssignments');
      expect(await c.courses.findOne(ctx.ids.algebra, knownCoach)).toHaveProperty('divisions');
      expect(await c.courses.findOne(ctx.ids.algebra, knownStudent)).toHaveProperty('counts');
    });

    it('G3 resource list: admin and assigned coach see the unpublished resource; the student does not', async () => {
      const ids = (rows: unknown) => (rows as Array<{ id: string }>).map((r) => r.id);
      expect(ids(await c.courses.listResources(ctx.ids.algebra, {} as never, knownAdmin))).toContain(f.resourceId);
      expect(ids(await c.courses.listResources(ctx.ids.algebra, {} as never, knownCoach))).toContain(f.resourceId);
      expect(ids(await c.courses.listResources(ctx.ids.algebra, {} as never, knownStudent))).not.toContain(f.resourceId);
    });

    it('G4 leaderboard: staff see full names; students see the anonymised form', async () => {
      const names = (page: unknown) => (page as { data: Array<{ displayName: string }> }).data.map((e) => e.displayName);
      const staff = names(await c.leaderboard.findGeneral(knownAdmin, { divisionId: ctx.ids.junior, page: 1, limit: 50 } as never));
      const student = names(await c.leaderboard.findGeneral(knownStudent, { page: 1, limit: 50 } as never));
      expect(staff.length).toBeGreaterThan(0);
      expect(staff.every((n) => !/ [A-Za-z]\.$/.test(n))).toBe(true);
      expect(student.every((n) => / [^ ]\.$/.test(n))).toBe(true);
    });

    it('G5 assignment list: coach and admin get the staff view incl. the assignment; student gets the summary', async () => {
      const page = (p: unknown) => (p as { data: Array<Record<string, unknown>> }).data;
      const coach = page(await c.assignments.findAll(knownCoach, { page: 1, limit: 50 } as never));
      expect(coach.map((x) => x.id)).toContain(f.assignmentId);
      expect(page(await c.assignments.findAll(knownAdmin, { page: 1, limit: 50 } as never)).map((x) => x.id)).toContain(f.assignmentId);
      const student = page(await c.assignments.findAll(knownStudent, { page: 1, limit: 50 } as never));
      expect(student.map((x) => x.id)).toContain(f.assignmentId);
      expect(Object.keys(student[0]).length).toBeLessThan(Object.keys(coach[0]).length);
    });

    it('course discussions: a student still lists threads without a divisionId; a coach still needs one (400)', async () => {
      await expect(c.discussions.listCourseThreads(ctx.ids.algebra, {} as never, knownStudent)).resolves.toBeDefined();
      expect(await outcome(() => c.discussions.listCourseThreads(ctx.ids.algebra, {} as never, knownCoach)))
        .toMatchObject({ ok: false, status: 400, code: 'DIVISION_REQUIRED' });
    });
  });
});
