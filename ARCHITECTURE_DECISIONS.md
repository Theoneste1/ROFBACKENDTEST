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
| 002 | TEACHER is a separate user type (**amended 2026-11-09**: six user types) | D2 | REG-01, REG-05 |
| 003 | Teacher default rights | Q2 | TCH-01, PERM-* |
| 004 | Permissions: catalogue in code; profiles, assignments, scopes, overrides in the database (**amended 2026-11-09**: role-based defaults + Super-Admin overrides in Phase 1; custom profiles deferred) | D3 | PERM-01…08 |
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
| 017 | Branching and integration (**corrected 2026-11-09**: `develop`) | — | §22.12 |
| 018 | Programme scope (Phase 1) — **2026-11-09** | — | PERM-04, TCH-01 |
| 019 | Super Admin (Phase 1) — **2026-11-09** | Q20 | PERM-06, PERM-07 |

**Amendments of 2026-11-09 (Phase 1):** ADR-002, ADR-003, ADR-004, ADR-015 and ADR-017 carry dated amendments below; ADR-018 and ADR-019 are new. Original decision text is kept. **Final owner sign-off (2026-11-09):** every Phase 1 decision has been explicitly decided by the owner — all approved except H7 (changed: deferred), plus owner safeguards AS1 and AS2. The status words in the amendments below reflect that sign-off; the register at the end of this document lists every decision ([docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §2).

---

## ADR-001 — Backend-first extension of the existing application

- **Decision:** implement the requirements backend-first, phase by phase (Phase 0–10); frontend work follows each phase once its backend APIs are verified. The existing application is extended, not rebuilt.
- **Consequences:** every phase keeps the full existing test suite green; existing API contracts change only additively unless a change is listed in API_CHANGE_PLAN §4.

## ADR-002 — TEACHER as a separate user type

- **Decision:** add `TEACHER` to the user type (`Role` enum: STUDENT, MENTOR (shown "Coach"), ADMIN, TEACHER). A user has one user type (multiple types per person remains open: Q9).
- **Consequences:** every role switch in backend and frontend handles TEACHER; the permission matrix covers it; the enum value is added in its own migration.
- **Amendment 2026-11-09 (Phase 1):**
  - **Six user types** (owner requirement, 2026-11-09): STUDENT, TEACHER, COACH, HEAD_COACH, ADMIN, SUPER_ADMIN.
  - **COACH stays stored as `MENTOR`** and is shown as "Coach" — no enum rename, because `MENTOR` is part of API responses, route/table names and audit history (*confirmed*, C1).
  - New stored values `TEACHER`, `HEAD_COACH`, `SUPER_ADMIN` are added together in one additive, forward-only migration, only after every route declares its access and role checks are hardened ([docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §4, §9).
  - The TEACHER permission work moves into Phase 1; teacher registration stays in Phase 5 (*confirmed*, D1).
  - One role per user remains (*open*, O6/Q9).

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
- **Amendment 2026-11-09 (Phase 1, *confirmed* — D2, D6, D7):**
  - In Phase 1 a teacher's scope is course × division through a separate `TeacherAssignment` table, plus programme membership, kept separate from coach grading assignments (*confirmed*, C8).
  - **School scope is deferred** to Phase 2/5 (Q21).
  - Preparing assignments is possible only through a Super-Admin override, using the existing assignment approval workflow.
  - Resource submission waits for Phase 7.
  - Student information is limited to name, school, grade and division — never grades, marks, feedback or contact details. Where "progress" is visible (Head Coaches), it means **participation and learning activity only** (owner clarification of D7).

## ADR-004 — Permission model

- **Decision:**
  - The **list of named permissions stays in code** (a fixed catalogue; e.g. `users.view`, `resources.approve`).
  - **Permission profiles**, **user assignments of profiles with a scope** (GLOBAL, COUNTRY, SCHOOL, SUBJECT, COURSE, DIVISION, GROUP, SUPPORT_ASSIGNED) and **individual overrides** (grant/deny) are **database records** managed through the Admin Portal.
  - **System profiles are seeded to reproduce today's STUDENT, MENTOR and ADMIN access exactly**; every existing user receives the profile of their role. Existing behaviour must not change when the foundation lands.
  - Effective permissions are resolved **server-side per request** (short-lived cache, invalidated on change), **not embedded in the JWT** — the authentication and refresh-token flow is unchanged.
  - **Default deny.** An administrator can only grant permissions and scopes they hold themselves; system profiles are editable only by the Super Administrator profile; all permission changes are audited with previous and new values.
  - Coach course × division assignments (`MentorAssignment`) remain the teaching scope; they are not replaced.
- **Consequences:** a new guard (`@RequirePermission`) coexists with `@Roles` during migration; an equivalence test proves both give the same answers for system profiles on every route.
- **Amendment 2026-11-09 — approved scope change (D3, *confirmed* by the owner):**
  - **Phase 1 implements fixed role-based default permissions** (one set per user type, defined in code) **and controlled individual overrides** (GRANT/DENY of one catalogue permission for one user, optionally scoped, with reason and optional expiry) stored in the database.
  - **Overrides are managed only by the Super Admin.** They are restricted to an approved permission list kept in code, audited in the same transaction as the change, reversible (soft revocation), and stop applying at their expiry time on every request.
  - Overrides cannot widen scope, cannot bypass record-level rules and cannot apply to a Super Admin ([docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §6.3–6.4).
  - **Administrator-created custom permission profiles (the "profiles … are database records managed through the Admin Portal" part of this decision, and requirement PERM-02) are DEFERRED to a later phase.** The original text above is kept and is marked deferred, not withdrawn.
  - The "Super Administrator profile" becomes the `SUPER_ADMIN` user type (ADR-019).
  - Permissions are still resolved server-side per request and are not stored in the JWT; the authentication and refresh flow is unchanged.
  - *Confirmed* (D9): instead of a transitional guard that accepts *either* the legacy role *or* the permission, each route switches to the permission check alone, after a generated equivalence test proves identical decisions for STUDENT, COACH and ADMIN. The approved override list and safeguards (OV) and the permission catalogue (PERM) are *confirmed*.

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

- **Exception 2026-11-09 (Phase 1, *confirmed*, C10):** while Phase 0 is paused, rule 2 (the CI migration-name check, task P0-06) is **not a prerequisite** for Phase 1. Every migration pull request instead states a manual check that its name sorts after the newest migration on `develop` and `main`. All other rules apply unchanged:
  - rule 4: rehearsal on a Neon point-in-time copy of production;
  - rule 5: met for additive migrations by the P0-04 Part A restore drill.

## ADR-016 — Staging environment

- **Decision:** introduce a staging environment on free tiers (Neon branch, second Render service, Netlify deploy preview) for rehearsing migrations and integrating frontend work before production.
- **Open:** exact hosting arrangement and who maintains staging data.

## ADR-017 — Branching and integration

- **Decision:** `main` is the release branch (Render deploys it). One feature branch per phase step, created from `main`; one pull request per step; CI green and review required; database migrations in their own pull requests, applied to production only with approval. **`develop` is kept (Q22, decided 2026-11-08):** after the pending pull request is reviewed and merged into `main`, `develop` is aligned with `main`.
- **Correction 2026-11-09 (*confirmed*, BR; supported by repository evidence):**
  - Feature branches are created from **`develop`**, and pull requests target **`develop`**. Evidence:
    - `develop` is the repository's default branch on GitHub;
    - pull requests #4–#9 targeted `develop`;
    - [docs/AI_COLLABORATION_PROTOCOL.md](docs/AI_COLLABORATION_PROTOCOL.md) names `develop`.
  - `main` remains the release branch.
  - A release is a pull request `develop → main`; Render deploys `main`.
  - The rest of this decision is unchanged.

## ADR-018 — Programme scope (Phase 1, 2026-11-09)

- **Decision (*confirmed*: HC-A, P2, P3):**
  - **Head Coach authority is limited to the assigned programme(s).**
  - A programme is an **existing `Discipline` record** (Mathematics today; its ID is unchanged). There is no programme table and no programme-management interface in Phase 1; Physics and Computing come with Phase 3.
  - A new link table, **`ProgrammeMembership`** (user × discipline, `source` BACKFILL/MANUAL, active flag, history), records who belongs to which programme. Head Coaches head the programmes they are members of; only ADMIN or SUPER_ADMIN sets that.
  - Existing users are backfilled:
    - the migration aborts unless Mathematics is the only discipline;
    - students → Mathematics;
    - coaches → the programmes of their assigned courses, otherwise Mathematics;
    - rows are marked `BACKFILL`, so a single delete reverses it;
    - it is verified on a Neon copy of production by reconciliation, access-regression, scope-isolation and rollback tests before production approval is requested.
  - **Membership never changes existing access:** students stay division-based and coaches stay `MentorAssignment`-based.
- **Confirmed (C3–C6):**
  - ADMIN appoints Head Coaches and runs ordinary programme operations.
  - Head Coaches manage Students and Coaches within their programme through explicit permissions.
  - Coach accounts created by a Head Coach need ADMIN approval.
  - Head Coaches have no automatic grading, no self-approval and no system-wide administration.
- **Confirmed (H2–H6, H8, H9):**
  - Student actions are limited to view, participation and learning activity, and programme membership.
  - "Assign coaches to students" means the Head Coach assigns **Coaches** to course × division responsibilities within their assigned programme, subject to the approved permissions; no coach–student table.
  - A Head Coach **personally** teaches or grades only through an explicit assignment **created by an Administrator** and the normal grading distribution; a Head Coach cannot assign themselves or another Head Coach.
  - Head Coaches do not approve assignments or results and do not manage resources.
  - **H7 changed (owner, 2026-11-09):** Head Coaches get **no discussion-moderation permission** in Phase 1; moderation rights for Head Coaches are deferred until they are designed separately with the discussion/communication features they apply to.
  - They may not export data or send bulk e-mail.
- **Enforcement:** a single place (`AccessService`) handles it. Anything outside the programme answers 404 (existence not revealed). Details are in [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §7.

## ADR-019 — Super Admin (Phase 1, 2026-11-09)

- **Decision (*confirmed*: S2, RS1):**
  - `SUPER_ADMIN` is the highest user type.
  - **The owner (Theoneste) will be the initial Super Admin.** The deputy is **unassigned** and receives no automatic rights.
  - The initial account is created **only** by a controlled one-off bootstrap command, which:
    - is tested on a disposable database and on a Neon copy of production first;
    - is run in production **only after separate explicit approval**.
  - No account is created or promoted during the documentation phase.
  - **The Super Admin permission set is defined explicitly and never includes grading or assignment-authoring permissions** (`reviews.grade`, `assignments.prepare`), neither by inheritance nor by override.
- **Confirmed (C2, C7):** ADMIN cannot manage ADMIN or SUPER_ADMIN accounts; SUPER_ADMIN has system-wide authority without automatic grading.
- **Confirmed (D4, S3–S5, BD):**
  - the bootstrap refuses if a Super Admin exists, and its target must be an existing active ADMIN (O1, not selected);
  - step-up password confirmation for role changes;
  - transfer only while another Super Admin remains;
  - a break-glass recovery runbook (command line only);
  - last-Super-Admin protection by both a service rule and a database trigger;
  - an append-only audit row for every state-changing ADMIN/SUPER_ADMIN request, without request bodies;
  - MFA deferred;
  - `settings.manageSystem` reserved for SUPER_ADMIN.
- **Owner safeguards (AS1, AS2, 2026-11-09):**
  - **AS1 — emergency recovery is restricted, documented and audited:** command line only, owner-held production access, mandatory reason and approval reference, a runbook in `docs/operations/`, and an audit row written in the same transaction as the change.
  - **AS2 — Super Admin transfer is atomic** and can never leave the system without an active Super Admin: one database transaction with row locks, re-checked by the last-Super-Admin trigger; any failure changes nothing.
- **Staged activation of C2 (*confirmed*, BD):** the ADMIN restriction sits behind `SUPER_ADMIN_BOUNDARY_ENABLED`, default off.
  - **Off:** ADMIN keeps today's behaviour.
  - **On while no active Super Admin exists:** the restriction is not enforced (fail-safe).
  - **When switched on:** only after a verified production bootstrap and a separate approval.
  - **Rollback:** switch it off.

  This guarantees that an ADMIN creation path always exists ([docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §8).

---

## Phase 1 decision register (2026-11-09)

Full wording in [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §2. **Final owner sign-off: 2026-11-09.**

| Status | Decisions |
|---|---|
| **Confirmed by the owner (before sign-off)** | Six user types (requirement) · HC-A Head Coach limited to assigned programme · D3 role-based defaults + Super-Admin-only overrides, custom profiles deferred · S2 owner is initial Super Admin, deputy unassigned, approval-gated bootstrap · P2 programme creation deferred to Phase 3 · P3 Mathematics membership backfill with safeguards · RS1 Super Admin never inherits grading · RS2 overrides stop at expiry independently of jobs · RS3 backfill acceptance tests · PR 1 scope |
| **Approved at the final sign-off** | C1–C10 · BR (`develop`) · D1, D2, D4, D5, D6, D9 · D7 (clarified: "progress" = participation and learning activity only; never grades, marks, feedback or contact details) · PERM · OV · H2, H3, H4, H5, H6, H8, H9 · S3, S4, S5 · BD |
| **Changed at the final sign-off** | H7 — Head Coach discussion moderation **deferred** until designed separately with the discussion/communication features |
| **Added by the owner** | AS1 emergency recovery restricted, documented and audited · AS2 atomic Super Admin transfer, never zero Super Admins |
| **Deferred** | custom permission profiles (PERM-02) · programme creation (Phase 3) · organisational role (D5) · Head Coach moderation (H7) · school/country scope · teacher resource submission (Phase 7) · teacher registration (Phase 5) · MFA (S3) · coach–student supervision links · O5 · O6 |
| **Open** | O1 bootstrap target account (not selected) · O2 deputy (unassigned) · O3 rotation of the seeded `admin` password (recommended before the bootstrap request) · O5 direct coach creation by Head Coaches · O6 several roles per person (Q9). O4 resolved (`develop`) |

---

## Unresolved decisions (to settle before the phase that needs them)

| # | Question | Needed by |
|---|---|---|
| Q3 | May a course belong to several topics? | Phase 3 |
| Q5 | Organisational role: free text or a managed list with permission meaning? — **2026-11-09: deferred out of Phase 1 (D5, approved)** | Phase 4/5 |
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
| ~~Q20~~ | **Decided 2026-11-09 (S2):** the owner (Theoneste) is the initial Super Admin through the approval-gated bootstrap; deputy unassigned; transfer and recovery rules confirmed in ADR-019 (D4, AS1, AS2) | Phase 1 |
| Q21 | How teachers are linked to schools: by registration (self-declared, then approved) or by admin assignment only? | Phase 5 |
| ~~Q22~~ | **Decided 2026-11-08:** keep `develop`; align it with `main` after the pending pull request is merged | Phase 0 |
| O1 | Which existing ADMIN account (the owner's) the Super Admin bootstrap promotes — **not selected**; a personal ADMIN account may need to be created first | before the bootstrap approval request |
| O2 | Deputy for the Super Admin — **unassigned**; any promotion separately approved | — |
| O3 | Rotate the seeded production `admin` password | before the bootstrap approval request (recommended) |
| ~~O4~~ | Base branch — **resolved 2026-11-09 by repository evidence**: `develop` (ADR-017 correction) | — |
| O5 | May Head Coaches later create coaches without ADMIN approval? | later phase |
| O6 | Several user types per person (same as Q9) | Phase 5 |
