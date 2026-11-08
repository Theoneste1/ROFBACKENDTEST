# Architecture decisions — ROF LMS

**Status of every decision below: APPROVED DESIGN DIRECTION (owner, 2026-11-08), subject to the final implementation review.**
"Approved design direction" means the approach is agreed; details (names, fields, endpoints) may still change during
implementation review, and each implementation step is reviewed before merge. Nothing here has been implemented yet.

Related: [ROF_LMS_CONSOLIDATED_REQUIREMENTS.md](ROF_LMS_CONSOLIDATED_REQUIREMENTS.md) · [BACKEND_REQUIREMENTS_AUDIT.md](BACKEND_REQUIREMENTS_AUDIT.md) ·
[BACKEND_IMPLEMENTATION_PLAN.md](BACKEND_IMPLEMENTATION_PLAN.md) · [DATABASE_CHANGE_PLAN.md](DATABASE_CHANGE_PLAN.md) ·
[API_CHANGE_PLAN.md](API_CHANGE_PLAN.md) · [BACKEND_TEST_PLAN.md](BACKEND_TEST_PLAN.md) · [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md)

| ADR | Decision | Audit ref. | Requirements |
|---|---|---|---|
| 001 | Backend-first, extend the existing application | — | §1.1, §21, §22 |
| 002 | TEACHER is a separate user type | D2 | REG-01, REG-05 |
| 003 | Teacher default rights | Q2 | TCH-01, PERM-* |
| 004 | Permissions: catalogue in code; profiles, assignments, scopes, overrides in the database | D3 | PERM-01…08 |
| 005 | Countries, education systems and configurable grade levels | D5 | INT-*, REG-03 |
| 006 | Per-course access setting | D4, Q4 | REG-04, ACA-05 |
| 007 | Subject → Topic → Course, preserving Mathematics data | D1 | SUB-* |
| 008 | Explicit account statuses and reversible archiving | D6 | ACC-12…14 |
| 009 | Generalised registration applications (coach + teacher) | D9 | REG-05/06/10 |
| 010 | Content revisions, starting with resources | D10 | PUB-03/04 |
| 011 | Shared publishing workflow states | — | PUB-01/02 |
| 012 | Student Support portal separate from the public contact form | Q1, D8 | SUP-* |
| 013 | Communication groups; no private messaging in release 1 | D7, Q6 | GRP-* |
| 014 | Targeted e-mail with preview and confirmation | — | GRP-05 |
| 015 | Migration and production safety rules (mandatory) | D11 | SEC-06, ARC-03 |
| 016 | Staging environment | D12 | ARC-04 |
| 017 | Branching and integration | — | §22.12 |

---

## ADR-001 — Backend-first extension of the existing application

- **Decision:** implement the requirements backend-first, phase by phase (Phase 0–10); frontend work follows each phase once its backend APIs are verified. The existing application is extended, not rebuilt.
- **Consequences:** every phase keeps the full existing test suite green; existing API contracts change only additively unless a change is listed in API_CHANGE_PLAN §4.

## ADR-002 — TEACHER as a separate user type

- **Decision:** add `TEACHER` to the user type (`Role` enum: STUDENT, MENTOR (shown "Coach"), ADMIN, TEACHER). A user has one user type (multiple types per person remains open: Q9).
- **Consequences:** every role switch in backend and frontend handles TEACHER; the permission matrix covers it; the enum value is added in its own migration.

## ADR-003 — Teacher default rights

- **Decision:** the system profile `teacher` grants, by default:
  - manage own profile;
  - access to the **schools, subjects and courses assigned** to the teacher (scoped);
  - create learning materials and **submit them for approval** (no direct publishing);
  - create assignments and submit them for approval **only where authorized** (a separately granted permission, not in the default profile);
  - participate in permitted academic discussions and communication groups;
  - view student information **only within the authorized scope**.
- **Not granted by default:** grading, user administration, publishing approval, any global administrative permission. Anything more comes from a permission profile or an explicit, authorized assignment (ADR-004).
- **Consequences:** teachers need scope assignments (SCHOOL, SUBJECT, COURSE) before they see content; resource and assignment approval workflows (ADR-010/011) must exist before teachers can contribute content.

## ADR-004 — Permission model

- **Decision:**
  - The **list of named permissions stays in code** (a fixed catalogue; e.g. `users.view`, `resources.approve`).
  - **Permission profiles**, **user assignments of profiles with a scope** (GLOBAL, COUNTRY, SCHOOL, SUBJECT, COURSE, DIVISION, GROUP, SUPPORT_ASSIGNED) and **individual overrides** (grant/deny) are **database records** managed through the Admin Portal.
  - **System profiles are seeded to reproduce today's STUDENT, MENTOR and ADMIN access exactly**; every existing user receives the profile of their role. Existing behaviour must not change when the foundation lands.
  - Effective permissions are resolved **server-side per request** (short-lived cache, invalidated on change), **not embedded in the JWT** — the authentication and refresh-token flow is unchanged.
  - **Default deny.** An administrator can only grant permissions and scopes they hold themselves; system profiles are editable only by the Super Administrator profile; all permission changes are audited with previous and new values.
  - Coach course × division assignments (`MentorAssignment`) remain the teaching scope; they are not replaced.
- **Consequences:** a new guard (`@RequirePermission`) coexists with `@Roles` during migration; an equivalence test proves both give the same answers for system profiles on every route.

## ADR-005 — International academic structure

- **Decision:** reference tables for **Country**, **EducationSystem** and **GradeLevel** (plus an optional single **Region** level); schools link to a country (and region) with a type and active flag; uniqueness of schools becomes per country. **Rwanda is seeded with P1–P6 and S1–S6.** The `GradeLevel` enum is replaced by expand–contract; grade-to-division mapping moves into data. Junior and Senior divisions keep working.
- **Consequences:** responses keep the current `gradeLevel` string while adding the reference object; registration offers grades and schools per selected country.

## ADR-006 — Per-course access setting

- **Decision:** each course has an access policy: `DIVISION_OPEN` (today's behaviour) or `ENROLLMENT_REQUIRED`.
  - **Existing courses keep `DIVISION_OPEN`** (set explicitly by the migration).
  - **New courses default to `ENROLLMENT_REQUIRED`.**
  - Only users with the course-access permission (`courses.manageAccess`, scoped) may change it.
  - **Changing access must not expose restricted content by accident:** widening access (to `DIVISION_OPEN`) requires an explicit confirmation flag in the request, shows the number of newly entitled students, and is audited; narrowing takes effect immediately.
  - Enrollment is separate from registration; enrollment grants are recorded with who granted them.
- **Consequences:** student course and resource queries evaluate the policy; a regression test proves existing courses are unchanged.

## ADR-007 — Subject → Topic → Course, preserving Mathematics

- **Decision:** the existing `Discipline` table becomes **Subject** (same table and IDs; API name `subjects`, `/disciplines` kept as an alias). A new **Topic** level sits under Subject. **Course** remains the container for resources and assessments and gains an optional `topicId`. For Mathematics, one topic is created per existing course (Algebra, Geometry, Number Theory, Combinatorics) and linked to it. **No existing ID or relationship changes.**
- **Open:** whether a course may belong to several topics (Q3).

## ADR-008 — Account statuses and reversible archiving

- **Decision:** explicit `User.status` — PENDING_VERIFICATION, PENDING_APPROVAL, ACTIVE, SUSPENDED, REJECTED, ARCHIVED — with a defined transition table and status history, backfilled from the current flags. Deleting a user **archives** it (reversible, with restore); permanent deletion is a separate, restricted operation governed by retention rules (Q16).

## ADR-009 — Generalised registration applications

- **Decision:** generalise coach applications (`MentorRequest`) to cover teacher applications, with extended fields, rejection reasons and a request-information step. **Existing endpoints (`/mentor-requests`) keep working**; a new name (`/registration-applications`) is added as the primary path.

## ADR-010 — Content revisions, starting with resources

- **Decision:** editing published content creates a **new revision**; **the published version stays visible until the new revision is approved**; version history records who created, edited, reviewed and approved each revision. Resources first; published-assignment revisions second.

## ADR-011 — Shared publishing workflow

- **Decision:** one set of content states — DRAFT, PENDING_APPROVAL, CHANGES_REQUESTED, PUBLISHED, REJECTED, UNPUBLISHED, ARCHIVED — with transitions governed by permissions. Coaches keep today's direct publishing of resources through their seeded system profile (ADR-004); teachers always go through approval (ADR-003).
- **Open:** exact meaning of CHANGES_REQUESTED vs REJECTED and which content types require approval (Q7).

## ADR-012 — Student Support and Services portal

- **Decision:** **keep both**: the **public contact form** stays for general enquiries from anyone; **Student Support and Services** is a **separate authenticated portal** for registered students. Support requests have **reference numbers, assigned staff, status tracking, internal notes and student-visible responses**. Internal notes are never returned to students. Categories are data; the status set is fixed with defined transitions (configurable per category later). Coach meeting requests are a request type; submitting never confirms a meeting.
- **Open:** meeting scheduling depth (Q8).

## ADR-013 — Communication groups

- **Decision (release 1):** independent communication groups (membership independent of courses and divisions) with **announcements, discussions, replies, mentions, notifications and moderation**, and **delegated group administrators** whose rights are limited to their groups. **No private one-to-one messaging** in release 1 (to be reconsidered later). Student safeguarding and moderation rules apply. Reuse the existing (disabled) study-groups module, discussion threads, moderation and reporting, notifications and e-mail.

## ADR-014 — Targeted e-mail

- **Decision:** extend the existing bulk e-mail outbox with audiences (group, user type, country, school, subject); **recipient preview and explicit confirmation are required** before sending; senders are limited to audiences within their scope; all bulk e-mails are logged and audited.

## ADR-015 — Migration and production safety rules (mandatory)

1. New migration names start at **`20261121000000`** and are **strictly increasing**.
2. A **CI check** rejects any migration whose name does not sort after the newest migration already on `main`.
3. Every structural migration has **written rollback instructions** (`rollback.sql` or documented steps).
4. Migrations are **rehearsed on a restored copy of production** before production deployment.
5. **Database backup and restoration are verified** (restore drill) before the first structural migration.
6. A **controlled Cloudflare R2 upload and download test** is performed before features that add uploads.
7. **No destructive production change without explicit approval.**
8. Expand–contract: add first, backfill, switch code, remove old structures only in a later, separately approved migration.

## ADR-016 — Staging environment

- **Decision:** introduce a staging environment on free tiers (Neon branch, second Render service, Netlify deploy preview) for rehearsing migrations and integrating frontend work before production.
- **Open:** exact hosting arrangement and who maintains staging data.

## ADR-017 — Branching and integration

- **Decision:** `main` is the release branch (Render deploys it). One feature branch per phase step, created from `main`; one pull request per step; CI green and review required; database migrations in their own pull requests, applied to production only with approval. **`develop` is kept (Q22, decided 2026-11-08):** after the pending pull request is reviewed and merged into `main`, `develop` is aligned with `main`.

---

## Unresolved decisions (to settle before the phase that needs them)

| # | Question | Needed by |
|---|---|---|
| Q3 | May a course belong to several topics? | Phase 3 |
| Q5 | Organisational role: free text or a managed list with permission meaning? | Phase 1 (step P3) |
| Q7 | CHANGES_REQUESTED vs REJECTED; which content types require approval | Phase 7 |
| Q8 | Meeting requests: proposed times + confirmation only, or in-platform scheduling? | Phase 8 |
| Q9 | Can one person hold several user types (e.g. teacher and coach)? | Phase 5 |
| Q10 | Which registration fields may admins make optional/mandatory? | Phase 5 |
| Q11 | Phone numbers unique? Format (E.164)? | Phase 5 |
| Q12 | Countries: all ISO countries (inactive by default) or a curated list? | Phase 2 |
| Q13 | Geographic levels: region only, or more? | Phase 2 |
| Q14 | School administrators: users with school scope, or contact records? | Phase 2 |
| Q15 | Do academic years differ by country/education system? | Phase 2 |
| Q16 | Retention periods; who may permanently delete or export personal data? | Phase 4 / 10 |
| Q17 | May students change school/grade themselves, or with approval? | Phase 4 |
| Q18 | E-mail read receipts wanted? (not recommended for minors) | Phase 10 |
| Q19 | Password policy for the international launch | Phase 5 |
| Q20 | Who holds the Super Administrator profile initially, and how is it transferred? | Phase 1 |
| Q21 | How teachers are linked to schools: by registration (self-declared, then approved) or by admin assignment only? | Phase 5 |
| ~~Q22~~ | **Decided 2026-11-08:** keep `develop`; align it with `main` after the pending pull request is merged | Phase 0 |
