# Frontend integration requirements — ROF LMS

**Updated:** 2026-11-08 · **For:** the frontend repository `ROFFRONTENDTEST` (Next.js 16, Netlify)
**Design status:** APPROVED DESIGN DIRECTION, subject to the final implementation review ([ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)).
**Timing:** frontend work for each phase starts only when that phase's backend APIs are verified (ADR-001).
**Backend sources:** [API_CHANGE_PLAN.md](API_CHANGE_PLAN.md), [BACKEND_IMPLEMENTATION_PLAN.md](BACKEND_IMPLEMENTATION_PLAN.md),
current integration contract in [docs/INTEGRATION.md](docs/INTEGRATION.md).

The frontend talks to `/api/v1` through its `/api` proxy (uploads go directly to the backend). Authentication
(15-minute access token in memory, rotating `rof_refresh` cookie) **does not change**.

## 0. Prerequisite: production frontend

`https://roflms.netlify.app` serves Netlify's 404 today. Branch `feature/production-readiness` fixes the build
(backend URL in `netlify.toml`). It must be deployed before any new feature can be tested in production; the
backend's e-mail links already point to this site.

## 1. Changes the frontend must handle even before using new features

| Change | Required frontend action |
|---|---|
| New user type `TEACHER` in `role` (ADR-002) | Every role switch/guard/label handles TEACHER (show "Teacher"); unknown roles must not crash; a teacher dashboard shows only assigned schools/subjects/courses and offers "submit for approval" — never publish, approve or grade unless `/me/permissions` grants it (ADR-003) |
| `/me/permissions` extended `{ role, permissions[], scopes[], profiles[] }` | Drive navigation and buttons from `permissions` (+ scopes) instead of `role`; keep working with the current shape |
| New notification types/categories (SUPPORT, GROUPS, PUBLISHING) | Unknown types shown generically; links followed when present |
| `gradeLevel` also returned as an object (`gradeLevelRef`) | Keep reading the string until screens move to the reference data |
| Resources gain `status`/`publishedRevision` (`isPublished` kept) | No change required until the publishing UI is built |
| `DELETE /admin/users/:id` now archives | Wording "Archive user" + restore action; handle new error codes |
| New error codes (`APPROVAL_REQUIRED`, `SCOPE_FORBIDDEN`, `INVALID_STATUS_TRANSITION`, `REGISTRATION_CLOSED`, `PREVIEW_REQUIRED`, …) | Show the backend `message`; map codes to friendly text |

## 2. New screens and integrations by workstream

| Workstream | Screens | Key endpoints | Permissions to check |
|---|---|---|---|
| Permissions | Admin → Access management: profiles list/editor (catalogue grouped by area), user permission assignments with scope picker, overrides | `/admin/permissions/catalogue`, `/admin/permission-profiles*`, `/admin/users/:id/permission-assignments*` | `permissions.view`, `.manage`, `.assign` |
| Reference data | Admin → Countries, regions, education systems, grade levels; Schools management (create/edit/deactivate/import) | `/reference/*`, `/admin/countries*`, `/admin/schools*` | `reference.manage`, `schools.manage` |
| Subjects/topics | Admin → Subjects & topics (create, icon upload, order, publish/archive, availability); course creation; student "Subjects" page and topic browsing | `/subjects*`, `/admin/subjects*`, `/admin/topics*`, `POST /admin/courses` | `subjects.manage`, `topics.manage`, `courses.manage` |
| Accounts | User status badges and transitions with reasons; archive/restore; bulk actions; export; account history tab | `/admin/users/:id/transition`, `/restore`, `/history`, `/admin/users/bulk`, `/admin/users/export.csv` | `users.*` |
| Registration | Registration by user type (student, teacher, coach) driven by `GET /registration/form`; country → school → grade cascading selects; subject multi-select; guardian fields; avatar upload; admin review queue with reject reason and request-info | `/registration/form`, `/auth/register/student|teacher`, `/mentor-requests` (extended), `/admin/registrations`, `/registration-applications/*` | `registrations.*` |
| Profiles | Profile editing (picture, contacts, country/location, school, academic info, interests); sensitive fields masked unless permitted | `PATCH /me`, `POST /me/avatar` | `users.viewSensitive` for admins |
| Course access (ADR-006) | Course access setting per course (new courses default to "Enrollment required"); widening to division access shows the affected-student count and requires confirmation (`CONFIRMATION_REQUIRED` → confirm dialog → resend with `confirm: true`); enrollment management (grant/revoke); restricted courses never shown to unenrolled students | `PATCH /admin/courses/:id/access`, `/admin/courses/:id/enrollments*` | `courses.manageAccess`, `enrollments.manage` |
| Publishing | Coach: edit published resource → creates revision, submit for approval; Admin → Approvals queue (resources + assignments), diff/preview, approve/request changes/reject, history | `/courses/:c/resources/:id/revisions*`, `/admin/approvals` | `resources.manage`, `resources.approve`, `assignments.publish` |
| Student support (ADR-012) | **Separate authenticated portal**; the public contact form stays as it is. Student: Support portal (new request, attachments, reference number, status timeline, messages); Staff: request list with filters, assignment, priority, status, internal notes (visually distinct), meetings | `/support/*`, `/me/support/requests`, `/admin/support/*` | `support.*` |
| Groups (ADR-013) | **No private one-to-one messaging UI.** Groups directory/my groups, group page (announcements, discussions, replies, mentions, members), group admin tools for delegated group admins (only their groups), reporting and moderation; targeted e-mail with audience builder, **preview then confirm** | `/groups*`, `/me/groups`, `/admin/groups*`, `/admin/email/preview`, `/admin/email/send` | `groups.*`, `email.bulkSend` |
| Admin pages already backed by APIs (not yet built) | Academic years & enrollments, bulk e-mail jobs, activity log | `/admin/academic-years*`, `/admin/email/*`, `/admin/activity*` | existing |

## 3. UX rules from the requirements

- Show only functions the user is permitted to use (requirement §12); never rely on hiding for security — the backend enforces everything.
- No non-functional placeholders (§12, development rule 8).
- Registration adapts to the country (grades, schools) and never assumes the Rwandan system (§2.1).
- Internal support notes and guardian contact data must never appear in student-facing screens (§9.2, §16.1).
- Modern, age-appropriate login/registration visuals (§13) without changing login, activation, reset or session behaviour.
- Responsive and accessible on phone, tablet and desktop (§19).

## 4. Contract process

1. Backend publishes OpenAPI (`docs/api/openapi.json`) with each pull request; additive changes only unless listed in API_CHANGE_PLAN §4.
2. Frontend integrates against a staging backend (D12) before production.
3. Each workstream adds cross-app journeys to the shared journey scripts (registration by type, support request with internal note, group announcement, revision approval).
4. A feature is "done" only when its backend tests, frontend build and cross-app journey pass.
