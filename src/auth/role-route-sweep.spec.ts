/**
 * Role × route sweep (completion programme, 2026-11-18): the REAL global guard chain (JwtAuthGuard → RolesGuard →
 * PermissionGuard; only Passport's token check stubbed) decides every route of the code for EVERY caller —
 * anonymous, STUDENT, TEACHER, MENTOR, HEAD_COACH, ADMIN, SUPER_ADMIN — not only the P1-02 baseline callers.
 *
 * Invariants (any violation names the route):
 *   1. Anonymous callers reach only @Public routes.
 *   2. Portal isolation: no Student or Teacher reaches an /admin route; no Student, Teacher or Coach reaches a
 *      /teacher route except Teachers (and Administrators where the service then answers ROLE_NOT_SUPPORTED);
 *      Coach-only (/mentor) routes are closed to Students and Teachers. The few non-administrator /admin routes are
 *      listed here by name (Head Coach programme management, the Coach's own course × division scope).
 *   3. A Super Administrator reaches every route an Administrator reaches.
 *   4. No administrator role reaches a grading route (ADMIN_PROHIBITED permissions).
 *   5. The per-role totals are frozen: a change in who reaches how many routes must change this file on purpose.
 *
 * Only the routes the running application registers count (docs/api/routes.json): StudyGroupsModule is in the code
 * but deliberately not registered (route-declarations.spec.ts names its handlers).
 *
 * With WRITE_ROLE_MATRIX=<file>, the full matrix is written as Markdown (evidence for the permission sweep).
 */
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { PermissionGuard } from './guards/permission.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { REQUIRED_PERMISSION_KEY } from './decorators/require-permission.decorator.js';
import { PermissionService } from './permission.service.js';
import { ADMIN_PROHIBITED } from './permissions.js';
import { AppError } from '../common/errors/app-error.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';
import { SRC, discoverHandlers, keyOf, type RouteHandler } from '../common/decorators/route-discovery.testing.js';

const CALLERS = ['anonymous', 'STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN', 'SUPER_ADMIN'] as const;
type Caller = (typeof CALLERS)[number];
type Decision = 'allow' | '401' | '403';

vi.spyOn(Object.getPrototypeOf(JwtAuthGuard.prototype) as { canActivate: (ctx: ExecutionContext) => unknown }, 'canActivate')
  .mockImplementation(function (this: unknown, ctx: ExecutionContext) {
    if (!ctx.switchToHttp().getRequest<{ user?: unknown }>().user) throw new UnauthorizedException();
    return true;
  });

const reflector = new Reflector();
const jwtGuard = new JwtAuthGuard(reflector);
const rolesGuard = new RolesGuard(reflector);
const permissionGuard = new PermissionGuard(reflector, new PermissionService({ mentorScopes: async () => [] } as never));

async function decide(h: RouteHandler, caller: Caller): Promise<Decision> {
  const user = caller === 'anonymous' ? undefined : { id: 'u1', username: 'u1', role: caller };
  const ctx = { getHandler: () => h.handler, getClass: () => h.cls, switchToHttp: () => ({ getRequest: () => ({ user }) }) } as unknown as ExecutionContext;
  try {
    if (!(await jwtGuard.canActivate(ctx))) return '401';
  } catch (err) {
    if (err instanceof UnauthorizedException) return '401';
    throw err;
  }
  if (!rolesGuard.canActivate(ctx)) return '403';
  try {
    return permissionGuard.canActivate(ctx) ? 'allow' : '403';
  } catch (err) {
    if ((err instanceof AppError && err.getStatus() === 403) || err instanceof ForbiddenException) return '403';
    throw err;
  }
}

const pathOf = (h: RouteHandler) => h.route.split(' ')[1];
const isPublic = (h: RouteHandler) => reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [h.handler, h.cls]) === true;
const permissionOf = (h: RouteHandler): string | undefined =>
  Reflect.getMetadata(REQUIRED_PERMISSION_KEY, h.handler) ?? Reflect.getMetadata(REQUIRED_PERMISSION_KEY, h.cls);

describe('role × route sweep (all seven callers)', () => {
  let rows: Array<{ h: RouteHandler; d: Record<Caller, Decision> }>;
  const allowed = (c: Caller) => rows.filter((r) => r.d[c] === 'allow');

  beforeAll(async () => {
    const registered = new Set((JSON.parse(readFileSync(join(SRC, '..', 'docs/api/routes.json'), 'utf8')) as Array<{ method: string; path: string }>)
      .map((x) => `${x.method} ${x.path.replace(/\{(\w+)\}/g, ':$1')}`));
    const handlers = (await discoverHandlers()).filter((h) => registered.has(h.route));
    expect(handlers.length).toBe(registered.size);
    rows = [];
    for (const h of handlers) {
      const d = {} as Record<Caller, Decision>;
      for (const c of CALLERS) d[c] = await decide(h, c);
      rows.push({ h, d });
    }
    const out = process.env.WRITE_ROLE_MATRIX;
    if (out) {
      const mark = (x: Decision) => (x === 'allow' ? '✓' : '');
      const lines = rows.map(({ h, d }) => `| ${h.route.replace(' ', ' | `')}\` | ${CALLERS.map((c) => mark(d[c])).join(' | ')} |`).sort();
      writeFileSync(out, `| Method | Path | ${CALLERS.join(' | ')} |\n|---|---|${CALLERS.map(() => ':-:').join('|')}|\n${lines.join('\n')}\n`);
    }
  }, 180_000);

  it('1. anonymous callers reach only @Public routes', () => {
    expect(rows.filter((r) => r.d.anonymous === 'allow' && !isPublic(r.h)).map((r) => keyOf(r.h))).toEqual([]);
  });

  it('2. portal isolation: Students and Teachers never reach /admin; /teacher is Teachers\' (and Administrators\'); /mentor is closed to Students and Teachers', () => {
    const admin = (r: { h: RouteHandler }) => pathOf(r.h).startsWith('/api/v1/admin/');
    const teacher = (r: { h: RouteHandler }) => pathOf(r.h).startsWith('/api/v1/teacher/');
    const mentor = (r: { h: RouteHandler }) => pathOf(r.h).startsWith('/api/v1/mentor/');
    expect(rows.filter((r) => admin(r) && (r.d.STUDENT === 'allow' || r.d.TEACHER === 'allow')).map((r) => keyOf(r.h))).toEqual([]);
    expect(rows.filter((r) => teacher(r) && (r.d.STUDENT === 'allow' || r.d.MENTOR === 'allow' || r.d.HEAD_COACH === 'allow'))
      .map((r) => `${keyOf(r.h)}  [${(['STUDENT', 'MENTOR', 'HEAD_COACH'] as const).filter((c) => r.d[c] === 'allow').join(',')}]`).sort())
      .toEqual(TEACHER_ROUTES_GUARD_ONLY);
    expect(rows.filter((r) => mentor(r) && (r.d.STUDENT === 'allow' || r.d.TEACHER === 'allow')).map((r) => keyOf(r.h))).toEqual([]);
    // The only /admin routes a Coach or Head Coach reaches (programme management for Head Coaches; reviewed here).
    expect(rows.filter((r) => admin(r) && (r.d.MENTOR === 'allow' || r.d.HEAD_COACH === 'allow'))
      .map((r) => `${keyOf(r.h)}  [${(['MENTOR', 'HEAD_COACH'] as const).filter((c) => r.d[c] === 'allow').join(',')}]`).sort())
      .toEqual(COACH_ADMIN_ROUTES);
  });

  it('3. a Super Administrator reaches every route an Administrator reaches', () => {
    expect(rows.filter((r) => r.d.ADMIN === 'allow' && r.d.SUPER_ADMIN !== 'allow').map((r) => keyOf(r.h))).toEqual([]);
  });

  it('4. no administrator role reaches a grading route', () => {
    const grading = rows.filter((r) => (ADMIN_PROHIBITED as readonly string[]).includes(permissionOf(r.h) ?? ''));
    expect(grading.length).toBeGreaterThan(0);
    expect(grading.filter((r) => r.d.ADMIN === 'allow' || r.d.SUPER_ADMIN === 'allow').map((r) => keyOf(r.h))).toEqual([]);
  });

  it('5. per-role totals (a change must be deliberate)', () => {
    expect(Object.fromEntries(CALLERS.map((c) => [c, allowed(c).length]))).toEqual(TOTALS);
  });
});

/**
 * Reviewed 2026-11-18: /admin routes a Coach or Head Coach passes the guards for — only the Head Coach's approved
 * programme management (P1-10, HC decisions) and, from 2026-11-19, Test Management Phase 1 (tests and marker
 * authorisations in the subjects they head; test/test-management.e2e-spec.ts) and Phase 3 (distribution, review,
 * choosing the mark; test/test-marking.e2e-spec.ts). Each service limits them to the programmes the Head Coach heads (others
 * are not revealed): test/head-coach-programme, head-coach-monitoring and head-coach-course-work e2e specs.
 */
const COACH_ADMIN_ROUTES: string[] = [
  'DELETE /api/v1/admin/mentor-assignments/:id  MentorAssignmentsController.unassign  [HEAD_COACH]',
  'DELETE /api/v1/admin/programmes/:id/members/:userId  AdminProgrammesController.endMember  [HEAD_COACH]',
  'DELETE /api/v1/admin/tests/:id  TestsController.remove  [HEAD_COACH]',
  'DELETE /api/v1/admin/tests/:id/files/:kind  TestsController.removeFile  [HEAD_COACH]',
  'DELETE /api/v1/admin/tests/:id/questions/:questionId  TestsController.removeQuestion  [HEAD_COACH]',
  'GET /api/v1/admin/activity  ActivityController.list  [HEAD_COACH]',
  'GET /api/v1/admin/activity/summary  ActivityController.summary  [HEAD_COACH]',
  'GET /api/v1/admin/dashboard  DashboardController.get  [HEAD_COACH]',
  'GET /api/v1/admin/mentor-assignments  MentorAssignmentsController.findAll  [HEAD_COACH]',
  'GET /api/v1/admin/programmes/:id/members  AdminProgrammesController.members  [HEAD_COACH]',
  'GET /api/v1/admin/programmes/:id/student-candidates  AdminProgrammesController.studentCandidates  [HEAD_COACH]',
  'GET /api/v1/admin/reports/course-participation  ReportsController.courseParticipation  [HEAD_COACH]',
  'GET /api/v1/admin/reports/mentor-activity  ReportsController.mentorActivity  [HEAD_COACH]',
  'GET /api/v1/admin/reports/mentors  ReportsController.mentors  [HEAD_COACH]',
  'GET /api/v1/admin/reports/students  ReportsController.students  [HEAD_COACH]',
  'GET /api/v1/admin/test-dashboard  AdminTestReportsController.dashboard  [HEAD_COACH]',
  'GET /api/v1/admin/test-markers  TestMarkersController.list  [HEAD_COACH]',
  'GET /api/v1/admin/test-markers/candidates  TestMarkersController.candidates  [HEAD_COACH]',
  'GET /api/v1/admin/test-reports  AdminTestReportsController.reports  [HEAD_COACH]',
  'GET /api/v1/admin/tests  TestsController.list  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id  TestsController.get  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/extension-targets  AdminTestExtensionsController.targets  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/extensions  AdminTestExtensionsController.list  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/files/:kind  TestsController.file  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/marking  AdminTestMarkingController.overview  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/marking/history  AdminTestMarkingController.history  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/marking/submissions  AdminTestMarkingController.list  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/marking/submissions/:submissionId  AdminTestMarkingController.get  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/results  AdminTestResultsController.list  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/results/export.csv  AdminTestResultsController.exportCsv  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/results/preview  AdminTestResultsController.preview  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/results/publications  AdminTestResultsController.publications  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/results/rankings  AdminTestResultsController.rankings  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/results/report  AdminTestResultsController.report  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/submissions  AdminTestSubmissionsController.list  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/submissions/:submissionId  AdminTestSubmissionsController.get  [HEAD_COACH]',
  'GET /api/v1/admin/tests/:id/submissions/:submissionId/versions/:versionId/pages/:page  AdminTestSubmissionsController.page  [HEAD_COACH]',
  'GET /api/v1/admin/tests/subjects  TestsController.subjects  [HEAD_COACH]',
  'PATCH /api/v1/admin/tests/:id  TestsController.update  [HEAD_COACH]',
  'PATCH /api/v1/admin/tests/:id/extensions/:extensionId  AdminTestExtensionsController.update  [HEAD_COACH]',
  'PATCH /api/v1/admin/tests/:id/questions/:questionId  TestsController.updateQuestion  [HEAD_COACH]',
  'POST /api/v1/admin/mentor-assignments  MentorAssignmentsController.assign  [HEAD_COACH]',
  'POST /api/v1/admin/programmes/:id/coach-invitations  AdminProgrammesController.inviteCoach  [HEAD_COACH]',
  'POST /api/v1/admin/programmes/:id/members  AdminProgrammesController.addMember  [HEAD_COACH]',
  'POST /api/v1/admin/test-markers  TestMarkersController.grant  [HEAD_COACH]',
  'POST /api/v1/admin/test-markers/:id/revoke  TestMarkersController.revoke  [HEAD_COACH]',
  'POST /api/v1/admin/tests  TestsController.create  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/extensions  AdminTestExtensionsController.create  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/extensions/:extensionId/cancel  AdminTestExtensionsController.cancel  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/marking/assign  AdminTestMarkingController.assign  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/marking/distribute  AdminTestMarkingController.distribute  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/approve  AdminTestMarkingController.approve  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/choose  AdminTestMarkingController.choose  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/reassign  AdminTestMarkingController.reassign  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/return  AdminTestMarkingController.returnForCorrection  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/second-marking  AdminTestMarkingController.secondMarking  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/unlock  AdminTestMarkingController.unlock  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/publish  TestsController.publish  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/questions  TestsController.addQuestion  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/results/publish  AdminTestResultsController.publish  [HEAD_COACH]',
  'POST /api/v1/admin/tests/:id/unpublish  TestsController.unpublish  [HEAD_COACH]',
  'PUT /api/v1/admin/tests/:id/files/:kind  TestsController.putFile  [HEAD_COACH]',
  'PUT /api/v1/admin/tests/:id/questions/order  TestsController.reorderQuestions  [HEAD_COACH]',
];

/**
 * Reviewed 2026-11-18: /teacher routes whose permission (students.viewScoped) a Head Coach also holds (programme scope).
 * The guard lets them through; the service refuses every non-Teacher with 403 ROLE_NOT_SUPPORTED (as for
 * Administrators, who hold it too) — tested in test/teachers.e2e-spec.ts and test/teacher-student-access.e2e-spec.ts.
 */
const TEACHER_ROUTES_GUARD_ONLY: string[] = [
  // 2026-11-19, primary teacher: the teacher's own schools and role (same rule: 403 ROLE_NOT_SUPPORTED for non-Teachers).
  'GET /api/v1/teacher/schools  TeacherOwnSchoolsController.list  [HEAD_COACH]',
  'GET /api/v1/teacher/students  TeacherStudentsController.list  [HEAD_COACH]',
  'GET /api/v1/teacher/students/summary  TeacherStudentsController.summary  [HEAD_COACH]',
];

/**
 * 2026-11-18, 315 registered routes. The Super Administrator's extra six: individual permission overrides (list,
 * create, revoke) and the school-directory sync's approve, apply and resolve.
 */
// 2026-11-19, countries (owner decision): +1 public list for every caller, +2 reference.manage routes for Administrators
// and Super Admins only (none for Coach, Head Coach, Teacher or Student).
// 2026-11-19, primary teacher (owner decision): +1 POST /admin/teacher-assignments/:id/primary (users.manageTeachers:
// Administrators, Super Admins); +1 GET /teacher/schools (students.viewScoped: Teachers; the guard also admits Head Coaches
// and Administrators, whom the service refuses — TEACHER_ROUTES_GUARD_ONLY).
// 2026-11-19, Test Management Phase 1 (owner-approved plan): +19 /admin/tests and /admin/test-markers routes for Head
// Coaches (their subjects), Administrators and Super Admins; none for Coach, Teacher or Student.
// 2026-11-19, Test Management Phase 2: +8 /me/tests routes (tests.submit: Students); +9 /teacher/tests routes
// (tests.submitForStudents: Teachers, G2); +8 /admin/tests/:id/extensions, extension-targets and submissions routes for
// Head Coaches (their subjects), Administrators and Super Admins; none for Coaches.
// 2026-11-19, Test Management Phase 3: +7 /marking routes (tests.mark: Coaches only — never administrators, G4); +11
// /admin/tests/:id/marking routes (tests.distribute, tests.review) for Head Coaches (their subjects), Administrators and
// Super Admins; +1 choose (tests.adjustMarks) for Head Coaches only (G4).
// 2026-11-19, Test Management Phase 4: +3 Student routes (own results, dashboard); +4 Teacher routes (school results,
// dashboard); +1 Coach route (marking dashboard); +9 for Head Coaches (publication, results, rankings, report, export, the
// reporting overview, the staff dashboard — never the override); +10 for Administrators and Super Admins (the same and the
// override).
// 2026-11-19, generic bulk engine: +8 /admin/bulk/* routes (users.bulkManage: Administrators and Super Admins only).
const TOTALS: Record<Caller, number> = { anonymous: 26, STUDENT: 106, TEACHER: 97, MENTOR: 119, HEAD_COACH: 168, ADMIN: 346, SUPER_ADMIN: 352 };   // gender step (2026-11-20): +1 each signed-in caller (PUT /me/gender)
