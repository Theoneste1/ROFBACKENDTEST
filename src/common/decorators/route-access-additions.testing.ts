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
};
