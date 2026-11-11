/**
 * Route handlers added AFTER the P1-02 guard-decision baseline was captured
 * (route-access-baseline.json, which is never re-captured or edited).
 *
 * Each new handler is listed here with the decision it must give for every
 * baseline caller. The P1-02 regression test checks baseline handlers against
 * the baseline and these handlers against this list, so a new route can never
 * slip in undeclared or with unreviewed access. Test-only (excluded from the build).
 */
type Decision = 'allow' | '401' | '403';
export interface AddedRouteDecisions { anonymous: Decision; STUDENT: Decision; MENTOR: Decision; ADMIN: Decision; UNKNOWN_ROLE: Decision }

const SUPER_ADMIN_ONLY: AddedRouteDecisions = { anonymous: '401', STUDENT: '403', MENTOR: '403', ADMIN: '403', UNKNOWN_ROLE: '403' };
const ADMINISTRATORS:   AddedRouteDecisions = { anonymous: '401', STUDENT: '403', MENTOR: '403', ADMIN: 'allow', UNKNOWN_ROLE: '403' };
/** courses.view: every known role that views courses; an unknown role holds nothing. */
/** @Roles('STUDENT'): students only. */
const STUDENTS_ONLY: AddedRouteDecisions = { anonymous: '401', STUDENT: 'allow', MENTOR: '403', ADMIN: '403', UNKNOWN_ROLE: '403' };
/** @Public: everyone, signed in or not. */
const PUBLIC: AddedRouteDecisions = { anonymous: 'allow', STUDENT: 'allow', MENTOR: 'allow', ADMIN: 'allow', UNKNOWN_ROLE: 'allow' };
/** Granted only by an individual delegation (P1-11): no baseline caller holds it. */
const NOBODY_BY_DEFAULT: AddedRouteDecisions = { anonymous: '401', STUDENT: '403', MENTOR: '403', ADMIN: '403', UNKNOWN_ROLE: '403' };
const COURSE_VIEWERS:   AddedRouteDecisions = { anonymous: '401', STUDENT: 'allow', MENTOR: 'allow', ADMIN: 'allow', UNKNOWN_ROLE: '403' };

export const ADDED_SINCE_BASELINE: Readonly<Record<string, AddedRouteDecisions>> = {
  // P1-09 — individual permission overrides (permissions.manageOverrides: Super Admin only)
  'GET /api/v1/admin/users/:id/permission-overrides  PermissionOverridesController.list':                    SUPER_ADMIN_ONLY,
  'POST /api/v1/admin/users/:id/permission-overrides  PermissionOverridesController.create':                 SUPER_ADMIN_ONLY,
  'DELETE /api/v1/admin/users/:id/permission-overrides/:overrideId  PermissionOverridesController.revoke':    SUPER_ADMIN_ONLY,
  // P1-09 — reading effective permissions and the catalogue (permissions.view: ADMIN and SUPER_ADMIN)
  'GET /api/v1/admin/users/:id/permissions  PermissionOverridesController.effective':                       ADMINISTRATORS,
  'GET /api/v1/admin/permissions/catalogue  PermissionOverridesController.catalogue':                       ADMINISTRATORS,
  // P1-10 — programmes (read-only list: courses.view), heads (programmes.manageHeads) and members
  // (programmes.manageMembers; Head Coaches too, in programmes they head — HEAD_COACH is not a baseline caller)
  'GET /api/v1/programmes  ProgrammesController.list':                                                       COURSE_VIEWERS,
  'GET /api/v1/admin/programmes/:id/heads  AdminProgrammesController.heads':                                  ADMINISTRATORS,
  'PUT /api/v1/admin/programmes/:id/heads  AdminProgrammesController.setHeads':                               ADMINISTRATORS,
  'GET /api/v1/admin/programmes/:id/members  AdminProgrammesController.members':                              ADMINISTRATORS,
  'POST /api/v1/admin/programmes/:id/members  AdminProgrammesController.addMember':                           ADMINISTRATORS,
  'DELETE /api/v1/admin/programmes/:id/members/:userId  AdminProgrammesController.endMember':                ADMINISTRATORS,
  // P1-10 part 3 — coach invitation into a programme (users.manageCoaches; Head Coaches too, pending approval)
  'POST /api/v1/admin/programmes/:id/coach-invitations  AdminProgrammesController.inviteCoach':              ADMINISTRATORS,
  // P1-11 — teacher school assignments and delegations (users.manageTeachers)
  'GET /api/v1/admin/teacher-assignments  TeacherSchoolsController.list':                                     ADMINISTRATORS,
  'POST /api/v1/admin/teacher-assignments  TeacherSchoolsController.assign':                                  ADMINISTRATORS,
  'DELETE /api/v1/admin/teacher-assignments/:id  TeacherSchoolsController.end':                               ADMINISTRATORS,
  'GET /api/v1/admin/teachers/:id/delegations  TeacherDelegationsController.list':                            ADMINISTRATORS,
  'POST /api/v1/admin/teachers/:id/delegations  TeacherDelegationsController.grant':                          ADMINISTRATORS,
  'DELETE /api/v1/admin/teachers/:id/delegations/:overrideId  TeacherDelegationsController.revoke':           ADMINISTRATORS,
  // P1-11 — the teacher's school-scoped views. students.viewScoped: ADMIN holds it (guard allows; the
  // service serves Teachers only → 403 ROLE_NOT_SUPPORTED). The other three: delegation only.
  'GET /api/v1/teacher/students  TeacherStudentsController.list':                                             ADMINISTRATORS,
  'GET /api/v1/teacher/students/:id  TeacherStudentsController.profile':                                      NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/students/:id/progress  TeacherStudentsController.progress':                            NOBODY_BY_DEFAULT,
  'POST /api/v1/teacher/students/:id/submissions  TeacherStudentsController.submit':                          NOBODY_BY_DEFAULT,
  // P1-11 — the official directory's Province → District → Sector tree for the Rwanda sign-up form
  'GET /api/v1/schools/locations  SchoolsController.locations':                                               PUBLIC,
  // School administration PR A — student–school verification (schools.manage: Administrators, Super Admins)
  'GET /api/v1/admin/school-affiliations  AdminSchoolAffiliationsController.list':                            ADMINISTRATORS,
  'GET /api/v1/admin/school-affiliations/:id  AdminSchoolAffiliationsController.get':                         ADMINISTRATORS,
  'POST /api/v1/admin/school-affiliations/:id/verify  AdminSchoolAffiliationsController.verify':              ADMINISTRATORS,
  'POST /api/v1/admin/school-affiliations/:id/reject  AdminSchoolAffiliationsController.reject':              ADMINISTRATORS,
  'POST /api/v1/admin/school-affiliations/:id/revoke  AdminSchoolAffiliationsController.revoke':              ADMINISTRATORS,
  'GET /api/v1/admin/users/:id/school-affiliations  AdminSchoolAffiliationsController.history':               ADMINISTRATORS,
  'GET /api/v1/me/school-affiliation  MySchoolAffiliationController.mine':                                    STUDENTS_ONLY,
  // School administration PR B — school records (schools.manage: Administrators, Super Admins)
  'GET /api/v1/admin/schools  AdminSchoolsController.list':                                                   ADMINISTRATORS,
  'GET /api/v1/admin/schools/:id  AdminSchoolsController.get':                                                ADMINISTRATORS,
  'GET /api/v1/admin/schools/:id/students  AdminSchoolsController.students':                                  ADMINISTRATORS,
  'POST /api/v1/admin/schools  AdminSchoolsController.create':                                                ADMINISTRATORS,
  'PATCH /api/v1/admin/schools/:id  AdminSchoolsController.update':                                           ADMINISTRATORS,
  'PATCH /api/v1/admin/schools/:id/active  AdminSchoolsController.setActive':                                 ADMINISTRATORS,
  // School administration PR C — claim resolution (schools.manage) and the student's own claim (STUDENT)
  'POST /api/v1/admin/school-affiliations/:id/match  AdminSchoolAffiliationsController.match':                ADMINISTRATORS,
  'POST /api/v1/admin/school-affiliations/:id/reopen  AdminSchoolAffiliationsController.reopen':              ADMINISTRATORS,
  'GET /api/v1/admin/school-affiliations/:id/candidates  AdminSchoolAffiliationsController.candidates':       ADMINISTRATORS,
  'POST /api/v1/me/school-affiliation  MySchoolAffiliationController.request':                                STUDENTS_ONLY,
};
