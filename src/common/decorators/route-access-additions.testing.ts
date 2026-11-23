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
/** tests.mark (Test Management Phase 3): Coaches only — Administrators never mark (ADMIN_PROHIBITED, G4). */
const COACHES_ONLY:     AddedRouteDecisions = { anonymous: '401', STUDENT: '403', MENTOR: 'allow', ADMIN: '403', UNKNOWN_ROLE: '403' };
/** students.classifyLevel (Olympiad levels, owner 2026-11-21): User Managers and Coaches (the service limits a Coach to their programmes' students). */
const ADMINS_AND_COACHES: AddedRouteDecisions = { anonymous: '401', STUDENT: '403', MENTOR: 'allow', ADMIN: 'allow', UNKNOWN_ROLE: '403' };
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
  // Owner 2026-11-20: a user without a gender gives it once (any signed-in user; asked of students, teachers, coaches)
  'PUT /api/v1/me/gender  MeController.setGender':                                                              SIGNED_IN,
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
  // Final review 2026-11-18 (owner approvals): date-of-birth corrections (users.manage) and application picture review
  'PUT /api/v1/admin/users/:id/date-of-birth  UsersController.correctDateOfBirth':                              ADMINISTRATORS,
  'GET /api/v1/admin/users/:id/date-of-birth-history  UsersController.dateOfBirthHistory':                      ADMINISTRATORS,
  'GET /api/v1/admin/teacher-applications/:id/avatar  AdminTeacherApplicationsController.avatar':              ADMINISTRATORS,
  'GET /api/v1/mentor-requests/:id/avatar  MentorRequestsController.avatar':                                    ADMINISTRATORS,
  'POST /api/v1/applications/info-requests/view  ApplicationInfoRequestsController.view':                    PUBLIC,
  'POST /api/v1/applications/info-requests/answer  ApplicationInfoRequestsController.answer':                 PUBLIC,
  // Optional profile picture right after registering (REG-02): the one-time token is the authorization.
  'PUT /api/v1/auth/register/avatar  RegistrationAvatarController.upload':                                   PUBLIC,
  // Registration timeline (REG-13): users.manage, as the user page.
  'GET /api/v1/admin/users/:id/registration-timeline  UsersController.registrationTimeline':                ADMINISTRATORS,
  // Teacher–student access (TS-1…TS-6): users.manageTeachers (Administrators); the teacher's counts: students.viewScoped
  // (ADMIN holds it — the service then answers 403 ROLE_NOT_SUPPORTED, as for the teacher's list).
  'GET /api/v1/admin/teacher-students  TeacherStudentAssignmentsController.list':                             ADMINISTRATORS,
  'POST /api/v1/admin/teacher-students  TeacherStudentAssignmentsController.assign':                          ADMINISTRATORS,
  'POST /api/v1/admin/teacher-students/reassign  TeacherStudentAssignmentsController.reassign':               ADMINISTRATORS,
  'DELETE /api/v1/admin/teacher-students/:id  TeacherStudentAssignmentsController.end':                       ADMINISTRATORS,
  'GET /api/v1/admin/schools/:id/access  SchoolAccessController.access':                                     ADMINISTRATORS,
  'GET /api/v1/admin/schools/:id/access/students  SchoolAccessController.students':                          ADMINISTRATORS,
  'POST /api/v1/admin/teachers/:id/delegations/:overrideId/students  TeacherDelegationsController.addStudents': ADMINISTRATORS,
  'DELETE /api/v1/admin/teachers/:id/delegations/:overrideId/students/:studentId  TeacherDelegationsController.removeStudent': ADMINISTRATORS,
  'POST /api/v1/admin/teachers/:id/delegations/:overrideId/reviewed  TeacherDelegationsController.reviewed':  ADMINISTRATORS,
  'GET /api/v1/teacher/students/summary  TeacherStudentsController.summary':                                  ADMINISTRATORS,
  // Countries (owner decision 2026-11-19): the public list (no sign-in; the registration forms read it) and its
  // administration (reference.manage: Administrators and Super Admins).
  'GET /api/v1/countries  CountriesController.list':                                                          PUBLIC,
  'GET /api/v1/admin/countries  AdminCountriesController.list':                                               ADMINISTRATORS,
  'PATCH /api/v1/admin/countries/:code  AdminCountriesController.update':                                     ADMINISTRATORS,
  // Primary teacher (owner decision 2026-11-19): Administrators choose a school's primary teacher (users.manageTeachers);
  // the teacher's own schools and role: students.viewScoped (ADMIN holds it — the service answers 403 ROLE_NOT_SUPPORTED).
  'POST /api/v1/admin/teacher-assignments/:id/primary  TeacherSchoolsController.makePrimary':                  ADMINISTRATORS,
  'GET /api/v1/teacher/schools  TeacherOwnSchoolsController.list':                                            ADMINISTRATORS,
  // Test Management, Phase 1 (WS3, owner-approved plan 2026-11-19): tests.view / tests.manage / tests.manageMarkers —
  // Administrators (every subject) and Head Coaches (HEAD_COACH is not a baseline caller; the subjects they head, checked
  // by the service). Coaches, Students and unknown roles: 403.
  'GET /api/v1/admin/tests/subjects  TestsController.subjects':                                                 ADMINISTRATORS,
  'GET /api/v1/admin/tests  TestsController.list':                                                              ADMINISTRATORS,
  'POST /api/v1/admin/tests  TestsController.create':                                                           ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id  TestsController.get':                                                           ADMINISTRATORS,
  'PATCH /api/v1/admin/tests/:id  TestsController.update':                                                      ADMINISTRATORS,
  'DELETE /api/v1/admin/tests/:id  TestsController.remove':                                                     ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/publish  TestsController.publish':                                              ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/unpublish  TestsController.unpublish':                                          ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/questions  TestsController.addQuestion':                                        ADMINISTRATORS,
  'PUT /api/v1/admin/tests/:id/questions/order  TestsController.reorderQuestions':                              ADMINISTRATORS,
  'PATCH /api/v1/admin/tests/:id/questions/:questionId  TestsController.updateQuestion':                        ADMINISTRATORS,
  'DELETE /api/v1/admin/tests/:id/questions/:questionId  TestsController.removeQuestion':                       ADMINISTRATORS,
  'PUT /api/v1/admin/tests/:id/files/:kind  TestsController.putFile':                                           ADMINISTRATORS,
  'DELETE /api/v1/admin/tests/:id/files/:kind  TestsController.removeFile':                                     ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/files/:kind  TestsController.file':                                              ADMINISTRATORS,
  'GET /api/v1/admin/test-markers  TestMarkersController.list':                                                 ADMINISTRATORS,
  'GET /api/v1/admin/test-markers/candidates  TestMarkersController.candidates':                                ADMINISTRATORS,
  'POST /api/v1/admin/test-markers  TestMarkersController.grant':                                               ADMINISTRATORS,
  'POST /api/v1/admin/test-markers/:id/revoke  TestMarkersController.revoke':                                   ADMINISTRATORS,
  // Test Management, Phase 2 (WS3, 2026-11-19): extensions (tests.extensions) and tracking (tests.viewSubmissions) —
  // Administrators (every subject) and Head Coaches (not baseline callers; the subjects they head, checked by the service).
  'GET /api/v1/admin/tests/:id/extensions  AdminTestExtensionsController.list':                                 ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/extension-targets  AdminTestExtensionsController.targets':                       ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/extensions  AdminTestExtensionsController.create':                              ADMINISTRATORS,
  'PATCH /api/v1/admin/tests/:id/extensions/:extensionId  AdminTestExtensionsController.update':                ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/extensions/:extensionId/cancel  AdminTestExtensionsController.cancel':          ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/submissions  AdminTestSubmissionsController.list':                               ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/submissions/:submissionId  AdminTestSubmissionsController.get':                  ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/submissions/:submissionId/versions/:versionId/pages/:page  AdminTestSubmissionsController.page': ADMINISTRATORS,
  // The student's own tests (tests.submit: Students only).
  'GET /api/v1/me/tests  MyTestsController.list':                                                               STUDENTS_ONLY,
  'GET /api/v1/me/tests/:id  MyTestsController.get':                                                            STUDENTS_ONLY,
  'GET /api/v1/me/tests/:id/paper  MyTestsController.paper':                                                    STUDENTS_ONLY,
  'GET /api/v1/me/tests/:id/uploads/:uploadKey  MyTestsController.pending':                                     STUDENTS_ONLY,
  'POST /api/v1/me/tests/:id/uploads/:uploadKey/pages/:page  MyTestsController.upload':                         STUDENTS_ONLY,
  'DELETE /api/v1/me/tests/:id/uploads/:uploadKey/pages/:page  MyTestsController.removePage':                   STUDENTS_ONLY,
  'POST /api/v1/me/tests/:id/submission  MyTestsController.submit':                                             STUDENTS_ONLY,
  'GET /api/v1/me/tests/:id/versions/:versionId/pages/:page  MyTestsController.page':                           STUDENTS_ONLY,
  // Teachers for their students (tests.submitForStudents: Teachers only — not a baseline caller, so nobody here).
  'GET /api/v1/teacher/tests  TeacherTestsController.list':                                                     NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/tests/:id/paper  TeacherTestsController.paper':                                          NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/tests/:id/students  TeacherTestsController.students':                                    NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/tests/:id/students/:studentId  TeacherTestsController.student':                           NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/tests/:id/students/:studentId/uploads/:uploadKey  TeacherTestsController.pending':        NOBODY_BY_DEFAULT,
  'POST /api/v1/teacher/tests/:id/students/:studentId/uploads/:uploadKey/pages/:page  TeacherTestsController.upload': NOBODY_BY_DEFAULT,
  'DELETE /api/v1/teacher/tests/:id/students/:studentId/uploads/:uploadKey/pages/:page  TeacherTestsController.removePage': NOBODY_BY_DEFAULT,
  'POST /api/v1/teacher/tests/:id/students/:studentId/submission  TeacherTestsController.submit':                NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/tests/:id/students/:studentId/versions/:versionId/pages/:page  TeacherTestsController.page': NOBODY_BY_DEFAULT,
  // Test Management, Phase 3 (WS3, 2026-11-19): distribution (tests.distribute) and review (tests.review) — Administrators
  // (every subject) and Head Coaches (not baseline callers; the subjects they head, checked by the service). Choosing /
  // adjusting the mark (tests.adjustMarks): the subject's Head Coach only — no baseline caller (G4: Administrators never).
  'GET /api/v1/admin/tests/:id/marking  AdminTestMarkingController.overview':                                   ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/marking/distribute  AdminTestMarkingController.distribute':                     ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/marking/assign  AdminTestMarkingController.assign':                             ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/marking/submissions  AdminTestMarkingController.list':                           ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/marking/submissions/:submissionId  AdminTestMarkingController.get':              ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/reassign  AdminTestMarkingController.reassign': ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/approve  AdminTestMarkingController.approve':  ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/return  AdminTestMarkingController.returnForCorrection': ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/second-marking  AdminTestMarkingController.secondMarking': ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/choose  AdminTestMarkingController.choose':    NOBODY_BY_DEFAULT,
  'POST /api/v1/admin/tests/:id/marking/submissions/:submissionId/unlock  AdminTestMarkingController.unlock':    ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/marking/history  AdminTestMarkingController.history':                            ADMINISTRATORS,
  // Blind marking (tests.mark: Coaches only; authorisation AND assignment checked by the service on every request).
  'GET /api/v1/marking/queue  MarkingController.queue':                                                         COACHES_ONLY,
  'GET /api/v1/marking/submissions/:code  MarkingController.get':                                               COACHES_ONLY,
  'GET /api/v1/marking/submissions/:code/pages/:page  MarkingController.page':                                  COACHES_ONLY,
  'GET /api/v1/marking/submissions/:code/paper  MarkingController.paper':                                       COACHES_ONLY,
  'GET /api/v1/marking/submissions/:code/marking-guide  MarkingController.guide':                               COACHES_ONLY,
  'PUT /api/v1/marking/submissions/:code/marking  MarkingController.save':                                      COACHES_ONLY,
  'POST /api/v1/marking/submissions/:code/marking/submit  MarkingController.submit':                            COACHES_ONLY,
  // Test Management, Phase 4 (WS3, 2026-11-19): publication (tests.publishResults), results with identity and reports
  // (tests.viewResults), rankings (tests.viewRankings) — Administrators (every subject) and Head Coaches (not baseline
  // callers; the subjects they head, checked by the service). The override (tests.overridePublication): Administrators only
  // (a Head Coach never: not in their grants, NEVER_GRANTABLE).
  'GET /api/v1/admin/tests/:id/results  AdminTestResultsController.list':                                       ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/results/preview  AdminTestResultsController.preview':                            ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/results/publish  AdminTestResultsController.publish':                           ADMINISTRATORS,
  'POST /api/v1/admin/tests/:id/results/publish/override  AdminTestResultsController.publishWithOverride':      ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/results/publications  AdminTestResultsController.publications':                  ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/results/rankings  AdminTestResultsController.rankings':                          ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/results/report  AdminTestResultsController.report':                              ADMINISTRATORS,
  'GET /api/v1/admin/tests/:id/results/export.csv  AdminTestResultsController.exportCsv':                       ADMINISTRATORS,
  'GET /api/v1/admin/test-reports  AdminTestReportsController.reports':                                         ADMINISTRATORS,
  'GET /api/v1/admin/test-dashboard  AdminTestReportsController.dashboard':                                     ADMINISTRATORS,
  // Students: their own published results (tests.viewOwnResults) and their dashboard (tests.submit).
  'GET /api/v1/me/test-results  MyTestResultsController.list':                                                  STUDENTS_ONLY,
  'GET /api/v1/me/test-results/:testId  MyTestResultsController.get':                                           STUDENTS_ONLY,
  'GET /api/v1/me/test-dashboard  MyTestResultsController.dashboard':                                           STUDENTS_ONLY,
  // Teachers (not baseline callers): their schools' published results (tests.viewSchoolResults) and their dashboard.
  'GET /api/v1/teacher/test-results  TeacherTestResultsController.list':                                        NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/test-results/:testId  TeacherTestResultsController.results':                             NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/test-results/:testId/students/:studentId  TeacherTestResultsController.result':          NOBODY_BY_DEFAULT,
  'GET /api/v1/teacher/test-dashboard  TeacherTestResultsController.dashboard':                                 NOBODY_BY_DEFAULT,
  // Coaches: their own marking dashboard (tests.mark; Administrators never mark).
  'GET /api/v1/marking/dashboard  MarkingDashboardController.dashboard':                                        COACHES_ONLY,
  // Generic bulk engine (2026-11-19): users.bulkManage on every route (Administrators, Super Admins); each action's own
  // permission(s) and each record's single-route policy are checked in BulkOperationsService / BulkOperationsWorker
  'GET /api/v1/admin/bulk/actions  BulkController.actions':                                                   ADMINISTRATORS,
  'GET /api/v1/admin/bulk/operations  BulkController.list':                                                   ADMINISTRATORS,
  'GET /api/v1/admin/bulk/operations/:id  BulkController.get':                                                ADMINISTRATORS,
  'GET /api/v1/admin/bulk/operations/:id/items  BulkController.items':                                        ADMINISTRATORS,
  'POST /api/v1/admin/bulk/operations/:id/cancel  BulkController.cancel':                                     ADMINISTRATORS,
  'POST /api/v1/admin/bulk/:entityType/preview  BulkController.preview':                                      ADMINISTRATORS,
  'POST /api/v1/admin/bulk/:entityType/export  BulkController.export':                                        ADMINISTRATORS,
  'POST /api/v1/admin/bulk/:entityType  BulkController.execute':                                              ADMINISTRATORS,  // Locked test submissions (owner 2026-11-21): an Administrator authorizes / cancels one more version of a submitted
  // answer (tests.authorizeResubmission: ADMIN and SUPER_ADMIN, never grantable), and revokes / restores a teacher's
  // test submission for students without touching the account (users.manageTeachers).
  'POST /api/v1/admin/tests/:id/submissions/:submissionId/resubmission  AdminTestSubmissionsController.authorizeResubmission': ADMINISTRATORS,
  'DELETE /api/v1/admin/tests/:id/submissions/:submissionId/resubmission  AdminTestSubmissionsController.cancelResubmission': ADMINISTRATORS,
  'GET /api/v1/admin/teachers/:id/test-submission  TeacherDelegationsController.testSubmission':              ADMINISTRATORS,
  'PUT /api/v1/admin/teachers/:id/test-submission  TeacherDelegationsController.setTestSubmission':           ADMINISTRATORS,
  // Olympiad levels (owner 2026-11-21): a student's level, its suggestion and history; set it or follow the grade again.
  'GET /api/v1/admin/students/:id/olympiad-level  OlympiadLevelController.view':                               ADMINS_AND_COACHES,
  'PUT /api/v1/admin/students/:id/olympiad-level  OlympiadLevelController.set':                                ADMINS_AND_COACHES,
  // Administrator-managed divisions (owner 2026-11-21/22): create one (divisions.manage).
  'POST /api/v1/admin/divisions  DivisionsController.create':                                                   ADMINISTRATORS,
  // The courses each division offers (divisions.manage); a coach on many course x division pairs at once
  // (mentorAssignments.manage: Administrators; Head Coaches too — not a baseline caller).
  'GET /api/v1/admin/divisions/:id/courses  DivisionsController.courses':                                       ADMINISTRATORS,
  'PUT /api/v1/admin/divisions/:id/courses  DivisionsController.setCourses':                                    ADMINISTRATORS,
  'POST /api/v1/admin/mentor-assignments/bulk  MentorAssignmentsController.bulkAssign':                         ADMINISTRATORS,
  // The Student Profile Overview (owner 2026-11-22): every signed-in caller; the service decides who may view whom (404).
  'GET /api/v1/students/:id/overview  StudentOverviewController.view':                                          SIGNED_IN,
  // Table layouts (owner 2026-11-22): own layouts (users.view), the organization default (settings.manage).
  'GET /api/v1/me/table-layouts/:table  TableLayoutsController.mine':                                           ADMINISTRATORS,
  'PUT /api/v1/me/table-layouts/:table  TableLayoutsController.saveMine':                                       ADMINISTRATORS,
  'DELETE /api/v1/me/table-layouts/:table  TableLayoutsController.resetMine':                                   ADMINISTRATORS,
  'PUT /api/v1/admin/table-layouts/:table  TableLayoutsController.saveOrg':                                     ADMINISTRATORS,
  'DELETE /api/v1/admin/table-layouts/:table  TableLayoutsController.resetOrg':                                 ADMINISTRATORS,
  // Custom reports (owner 2026-11-22): building (reports.build); a shared report's grants decide the rest (signed in).
  'GET /api/v1/reports/sources  CustomReportsController.sources':                                               ADMINISTRATORS,
  'POST /api/v1/reports  CustomReportsController.create':                                                       ADMINISTRATORS,
  'POST /api/v1/reports/preview  CustomReportsController.preview':                                              ADMINISTRATORS,
  'GET /api/v1/reports  CustomReportsController.list':                                                          SIGNED_IN,
  'GET /api/v1/reports/:id  CustomReportsController.get':                                                       SIGNED_IN,
  'PUT /api/v1/reports/:id  CustomReportsController.update':                                                    SIGNED_IN,
  'DELETE /api/v1/reports/:id  CustomReportsController.remove':                                                 SIGNED_IN,
  'POST /api/v1/reports/:id/preview  CustomReportsController.previewFor':                                       SIGNED_IN,
  'GET /api/v1/reports/:id/run  CustomReportsController.run':                                                   SIGNED_IN,
  'GET /api/v1/reports/:id/export  CustomReportsController.export':                                             SIGNED_IN,
  'GET /api/v1/reports/:id/grants  CustomReportsController.grants':                                             SIGNED_IN,
  'PUT /api/v1/reports/:id/grants  CustomReportsController.setGrants':                                          SIGNED_IN,
  // View as, read only (owner 2026-11-23): start (users.impersonate: Administrators and Super Admins; a Head Coach only by
  // an individual GRANT); the viewing tab's exchange and end are public (the ticket / the viewing token authenticates).
  'POST /api/v1/admin/users/:id/view-as  ViewAsAdminController.start':                                          ADMINISTRATORS,
  'POST /api/v1/auth/view-as/exchange  ViewAsAuthController.exchange':                                          PUBLIC,
  'POST /api/v1/auth/view-as/end  ViewAsAuthController.end':                                                    PUBLIC,
};
