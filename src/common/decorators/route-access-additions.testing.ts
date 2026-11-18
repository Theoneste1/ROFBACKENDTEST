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
/** @Authenticated: every signed-in caller, whatever the role (own data only, or data shown to every member). */
const SIGNED_IN:        AddedRouteDecisions = { anonymous: '401', STUDENT: 'allow', MENTOR: 'allow', ADMIN: 'allow', UNKNOWN_ROLE: 'allow' };

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
  // 2026-11-14 — students who can be added to a programme (programmes.manageMembers; Head Coaches too, own
  // programmes only and only students in no programme — HEAD_COACH is not a baseline caller)
  'GET /api/v1/admin/programmes/:id/student-candidates  AdminProgrammesController.studentCandidates':        ADMINISTRATORS,
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
  // School administration PR D — bulk school import (schools.manage)
  'GET /api/v1/admin/schools/import-template  AdminSchoolsController.importTemplate':                         ADMINISTRATORS,
  'POST /api/v1/admin/schools/import  AdminSchoolsController.import':                                         ADMINISTRATORS,
  // School directory S1 — contacts, offerings, history and reference data (schools.manage)
  'GET /api/v1/admin/schools/reference-data  AdminSchoolsController.referenceData':                           ADMINISTRATORS,
  'GET /api/v1/admin/schools/:id/contacts  AdminSchoolsController.contacts':                                  ADMINISTRATORS,
  'PUT /api/v1/admin/schools/:id/contacts  AdminSchoolsController.putContacts':                               ADMINISTRATORS,
  'POST /api/v1/admin/schools/:id/contacts/:contactId/verify  AdminSchoolsController.verifyContact':          ADMINISTRATORS,
  'GET /api/v1/admin/schools/:id/offerings  AdminSchoolsController.offerings':                                ADMINISTRATORS,
  'PUT /api/v1/admin/schools/:id/offerings  AdminSchoolsController.putOfferings':                             ADMINISTRATORS,
  'GET /api/v1/admin/schools/:id/history  AdminSchoolsController.history':                                    ADMINISTRATORS,
  // School directory S2a — directory sync dry runs and reports (schools.manage)
  'POST /api/v1/admin/school-sync/runs  SchoolSyncController.create':                                         ADMINISTRATORS,
  'GET /api/v1/admin/school-sync/runs  SchoolSyncController.list':                                            ADMINISTRATORS,
  'GET /api/v1/admin/school-sync/runs/:id  SchoolSyncController.get':                                         ADMINISTRATORS,
  'GET /api/v1/admin/school-sync/runs/:id/items  SchoolSyncController.items':                                 ADMINISTRATORS,
  'GET /api/v1/admin/school-sync/runs/:id/changes  SchoolSyncController.changes':                             ADMINISTRATORS,
  'GET /api/v1/admin/school-sync/runs/:id/report.csv  SchoolSyncController.report':                           ADMINISTRATORS,
  // School directory S2b — review (schools.manage) and approve / apply / resolve (schools.syncDirectory: Super Admins only)
  'GET /api/v1/admin/school-sync/runs/:id/review  SchoolSyncReviewController.summary':                         ADMINISTRATORS,
  'GET /api/v1/admin/school-sync/runs/:id/categories  SchoolSyncReviewController.categories':                  ADMINISTRATORS,
  'POST /api/v1/admin/school-sync/runs/:id/decisions  SchoolSyncReviewController.decide':                      ADMINISTRATORS,
  'POST /api/v1/admin/school-sync/runs/:id/items/:itemId/proposal  SchoolSyncReviewController.propose':        ADMINISTRATORS,
  'POST /api/v1/admin/school-sync/runs/:id/recompare  SchoolSyncReviewController.recompare':                   ADMINISTRATORS,
  'POST /api/v1/admin/school-sync/runs/:id/approve  SchoolSyncReviewController.approve':                       SUPER_ADMIN_ONLY,
  'POST /api/v1/admin/school-sync/runs/:id/apply  SchoolSyncReviewController.apply':                           SUPER_ADMIN_ONLY,
  'POST /api/v1/admin/school-sync/runs/:id/items/:itemId/resolve  SchoolSyncReviewController.resolve':         SUPER_ADMIN_ONLY,
  // E-mail deliveries across transactional and bulk e-mail (email.bulkSend, as the existing e-mail job routes)
  'GET /api/v1/admin/email/deliveries  EmailController.listAllDeliveries':                                    ADMINISTRATORS,
  'POST /api/v1/admin/email/deliveries/:id/retry  EmailController.retryDelivery':                             ADMINISTRATORS,
  // Teacher self-registration (owner-approved): public application, Administrator review (users.manageTeachers)
  'GET /api/v1/auth/register/teacher/availability  TeacherRegistrationController.availability':                PUBLIC,
  'POST /api/v1/auth/register/teacher  TeacherRegistrationController.register':                               PUBLIC,
  'GET /api/v1/admin/teacher-applications  AdminTeacherApplicationsController.list':                          ADMINISTRATORS,
  'GET /api/v1/admin/teacher-applications/:id  AdminTeacherApplicationsController.get':                       ADMINISTRATORS,
  'POST /api/v1/admin/teacher-applications/:id/approve  AdminTeacherApplicationsController.approve':          ADMINISTRATORS,
  'POST /api/v1/admin/teacher-applications/:id/reject  AdminTeacherApplicationsController.reject':            ADMINISTRATORS,
  // Decision notifications (owner-approved): school verification of a missing-school application
  // (users.manageTeachers) and the delivery log (email.bulkSend: Administrators, Super Admins)
  'POST /api/v1/admin/teacher-applications/:id/school  AdminTeacherApplicationsController.verifySchool':      ADMINISTRATORS,
  'GET /api/v1/admin/notification-deliveries  DecisionNotificationsController.list':                          ADMINISTRATORS,
  'POST /api/v1/admin/notification-deliveries/:id/retry  DecisionNotificationsController.retry':              ADMINISTRATORS,
  // Owner decision 2026-11-14: an administrator verifies a school (schools.manage, like every school edit).
  'POST /api/v1/admin/schools/:id/verify  AdminSchoolsController.verify':                                     ADMINISTRATORS,
  // Profile pictures (2026-11-15): own picture (any signed-in user), viewing (any signed-in user, never anonymous),
  // another account's picture (users.manage + the role policy on the target account, in AvatarService)
  'PUT /api/v1/me/avatar  MeController.setAvatar':                                                             SIGNED_IN,
  'DELETE /api/v1/me/avatar  MeController.removeAvatar':                                                       SIGNED_IN,
  // Owner decision 9.3 (2026-11-18): a student without a date of birth gives it at first sign-in
  'PUT /api/v1/me/date-of-birth  MeController.setDateOfBirth':                                                  STUDENTS_ONLY,
  'GET /api/v1/users/:id/avatar  UserAvatarController.avatar':                                                 SIGNED_IN,
  'PUT /api/v1/admin/users/:id/avatar  UsersController.setAvatar':                                             ADMINISTRATORS,
  'DELETE /api/v1/admin/users/:id/avatar  UsersController.removeAvatar':                                       ADMINISTRATORS,
  // Account states (2026-11-16): users.manage + the transition's permission and the role policy (AccountStatusService);
  // the history needs users.viewStatusHistory
  'POST /api/v1/admin/users/:id/status-changes  UsersController.changeStatus':                                 ADMINISTRATORS,
  'GET /api/v1/admin/users/:id/status-history  UsersController.statusHistory':                                 ADMINISTRATORS,
  // Bulk user operations (2026-11-17): users.bulkManage (export: users.export); each action's own permission and the
  // per-account role policy are checked in BulkOperationsService / BulkOperationsWorker
  'POST /api/v1/admin/users/bulk/preview  BulkOperationsController.preview':                                   ADMINISTRATORS,
  'POST /api/v1/admin/users/bulk  BulkOperationsController.execute':                                           ADMINISTRATORS,
  'GET /api/v1/admin/users/bulk  BulkOperationsController.list':                                               ADMINISTRATORS,
  'POST /api/v1/admin/users/bulk/export  BulkOperationsController.export':                                     ADMINISTRATORS,
  'GET /api/v1/admin/users/bulk/:id  BulkOperationsController.get':                                            ADMINISTRATORS,
  'GET /api/v1/admin/users/bulk/:id/items  BulkOperationsController.items':                                    ADMINISTRATORS,
  'POST /api/v1/admin/users/bulk/:id/cancel  BulkOperationsController.cancel':                                 ADMINISTRATORS,
  // Form availability (2026-11-15): the public view of every form (no sign-in), and the administrators' management
  // (forms.view, forms.manageAvailability, forms.editMessages: Administrators and Super Admins)
  'GET /api/v1/forms  FormsController.list':                                                                  PUBLIC,
  'GET /api/v1/forms/:key  FormsController.one':                                                              PUBLIC,
  'GET /api/v1/admin/forms  AdminFormsController.list':                                                       ADMINISTRATORS,
  'GET /api/v1/admin/forms/:key  AdminFormsController.one':                                                   ADMINISTRATORS,
  'GET /api/v1/admin/forms/:key/history  AdminFormsController.history':                                       ADMINISTRATORS,
  'PATCH /api/v1/admin/forms/:key/availability  AdminFormsController.availability':                           ADMINISTRATORS,
  'PATCH /api/v1/admin/forms/:key/messages  AdminFormsController.messages':                                   ADMINISTRATORS,
  // Request more information on applications (2026-11-17, ADR-009): Administrators ask (users.manageTeachers,
  // mentorRequests.decide); the applicant (no account) answers through the one-time link.
  'POST /api/v1/admin/teacher-applications/:id/request-info  AdminTeacherApplicationsController.requestInfo':  ADMINISTRATORS,
  'POST /api/v1/mentor-requests/:id/request-info  MentorRequestsController.requestInfo':                      ADMINISTRATORS,
  'GET /api/v1/applications/info-requests/:token  ApplicationInfoRequestsController.view':                    PUBLIC,
  'POST /api/v1/applications/info-requests/:token  ApplicationInfoRequestsController.answer':                 PUBLIC,
  // Optional profile picture right after registering (REG-02): the one-time token is the authorization.
  'PUT /api/v1/auth/register/avatar  RegistrationAvatarController.upload':                                   PUBLIC,
  // Registration timeline (REG-13): users.manage, as the user page.
  'GET /api/v1/admin/users/:id/registration-timeline  UsersController.registrationTimeline':                ADMINISTRATORS,
};
