# Backend implementation plan — ROF LMS

**Updated:** 2026-11-08 · **Design status:** APPROVED DESIGN DIRECTION, subject to the final implementation review
([ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)) · **Implementation status:** not started — no code before approval of each step.
Inputs: [ROF_LMS_CONSOLIDATED_REQUIREMENTS.md](ROF_LMS_CONSOLIDATED_REQUIREMENTS.md), [BACKEND_REQUIREMENTS_AUDIT.md](BACKEND_REQUIREMENTS_AUDIT.md),
[DATABASE_CHANGE_PLAN.md](DATABASE_CHANGE_PLAN.md), [API_CHANGE_PLAN.md](API_CHANGE_PLAN.md), [BACKEND_TEST_PLAN.md](BACKEND_TEST_PLAN.md).
Progress: [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md).

## 1. Ground rules

- Backend-first (ADR-001); frontend follows each phase once its backend APIs are verified.
- Extend, don't rebuild: every step names the existing module it builds on.
- One branch per step from `main`, one pull request per step, CI green, review before merge (ADR-017).
- Database changes follow the mandatory rules in ADR-015 and [DATABASE_CHANGE_PLAN.md](DATABASE_CHANGE_PLAN.md): names from `20261121000000`, strictly increasing; rollback instructions; rehearsal on a restored production copy; no destructive production change without explicit approval.
- Each step ends with: existing tests green, new tests for the step, OpenAPI regenerated, tracker and docs updated, no untested route.
- Nothing is marked complete because an API or table exists.

## 2. Phases

Sizes: S ≈ 1–2 days, M ≈ 3–5 days, L ≈ 1–2 weeks (one developer, including tests). Planning estimates only.

### Phase 0 — Stabilise existing work (no feature code)

| # | Step | Owner action needed | Exit criteria |
|---|---|---|---|
| 0.1 | Review the pending backend commits (`cc27c8d` e-mail settings, `962e1f0` docs, `f624d25` storage log) and the documents; prepare the pull request `feature/backend-completion → main` | go-ahead to push; review and merge | CI green; merged; Render logs show Resend and storage lines |
| 0.2 | Fix and deploy the frontend Netlify 404 (frontend branch `feature/production-readiness`) | merge in frontend repo | site serves the app |
| 0.3 | Regression baseline: tag, test counts, OpenAPI snapshot | — | tag `baseline-2026-11` |
| 0.4 | Verify database backup and restore (Neon restore drill to a branch) | Neon access | documented restore |
| 0.5 | Controlled R2 upload and download test | production coach/admin login (owner-run) | object in `rof-files`, identical download |
| 0.6 | CI migration-naming check | — | fails on a mis-named test migration |
| 0.7 | Align `develop` with `main` after 0.1 is merged (Q22 decided: keep `develop`) | approval | `develop` contains everything in `main` |
| 0.8 | Staging environment (ADR-016) | hosting setup | staging reachable |

### Phase 1 — Permissions and role management (ADR-002/003/004 amended, ADR-018, ADR-019) — Critical

**Updated 2026-11-09.** The full plan is [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md); task rows are in [IMPLEMENTATION_TRACKER.md](IMPLEMENTATION_TRACKER.md) (P1-01…P1-12). In summary:
- six user types;
- fixed role-based default permissions with Super-Admin-only individual overrides (custom profiles deferred, D3);
- programme scope on existing `Discipline` records with a `ProgrammeMembership` link table;
- a separate `TeacherAssignment`;
- Super Admin with an approval-gated bootstrap and a staged ADMIN boundary.

| # | Step | Size | Reuses |
|---|---|---|---|
| 1.1 | Every route declares access; positive role checks (unknown role → least privilege) | M | route metadata, `RolesGuard` |
| 1.2 | Six-role catalogue, `PermissionService`, `@RequirePermission`, equivalence framework, `/me/permissions` extended — **no route switched** | M | `permissions.ts`, `AccessService` |
| 1.3 | Role allow-list + flags; new role values (M1); frontend role tolerance | S | user DTOs |
| 1.4 | Convert routes to permission checks, area by area, after equivalence tests | L | — |
| 1.5 | Programme membership (M2 + M3 backfill), scope helpers | M | `AccessService` |
| 1.6 | Super Admin (no grading), safeguards, last-Super-Admin trigger (M4), bootstrap command (not run), boundary flag (off) | M | `AuditService` |
| 1.7 | Individual overrides (M5), approved list, expiry evaluated at `expiresAt` | M | `AuditService` |
| 1.8 | Head Coach (programme-scoped); Teacher (`TeacherAssignment`, M6) | L | `MentorAssignment`, reports |

Superseded steps (kept for history): 1.1 profile tables and system-profile backfill → replaced by role-based defaults in code (profiles deferred, D3); 1.2 "guard alongside `@Roles`" → permission-only per route after equivalence (D9, approved); 1.3 profile/assignment admin APIs → override API (Super Admin only).

### Phase 2 — Countries, education systems, grades and schools (ADR-005) — Critical

| # | Step | Size | Reuses |
|---|---|---|---|
| 2.1 | Country, Region, EducationSystem, GradeLevel; Rwanda P1–P6/S1–S6; public read + admin CRUD | M | settings/divisions patterns |
| 2.2 | Link users, enrollments, schools to the new references (backfill); keep `gradeLevel` string in responses | L | `grade-levels.ts` → data |
| 2.3 | School management (create/edit/deactivate/import, per-country uniqueness) | M | users CSV import |

### Phase 3 — Dynamic subjects and topics (ADR-007) — Critical

| # | Step | Size | Reuses |
|---|---|---|---|
| 3.1 | Subjects on `Discipline` (fields, status, icon, audit); `/subjects` + `/disciplines` alias | M | `Discipline`, `StorageService` |
| 3.2 | Topics; Math backfill (one topic per existing course, IDs preserved); course creation API (new courses `ENROLLMENT_REQUIRED`) | M | `CoursesService` |
| 3.3 | Subject availability rules; subject scopes for coaches/teachers | M | `AccessService`, Phase 1 scopes |

### Phase 4 — Account statuses and lifecycle (ADR-008) — High

| # | Step | Size | Reuses |
|---|---|---|---|
| 4.1 | `User.status`, transitions, history, backfill; login and lists use status | M | `UsersService.updateStatus` |
| 4.2 | Archive/restore (DELETE archives); restricted purge | S | users delete |
| 4.3 | Bulk actions; user export; per-user data export; account history; sensitive-field masking + read audit | M | CSV helpers, audit/activity |

### Phase 5 — Registration by user type (ADR-002, 003, 009) — High

| # | Step | Size | Reuses |
|---|---|---|---|
| 5.1 | `TEACHER` user type end to end; seeded `teacher` profile with **default rights only** (ADR-003); optional grantable profile for assignment authoring — **2026-11-09:** the TEACHER type and its permissions move to Phase 1 (D1, approved 2026-11-09); Phase 5 keeps teacher **registration and applications** | M | Phase 1 |
| 5.2 | Student fields (DOB, country, phones, guardian, interests, avatar) | M | registration DTOs, storage |
| 5.3 | Generalised applications (coach + teacher), review queue, rejection reasons, request-info loop, per-type switches, form configuration; `/mentor-requests` kept | M | `MentorRequest`, activation e-mails |

### Phase 6 — Course access and enrollment (ADR-006) — High

| # | Step | Size | Reuses |
|---|---|---|---|
| 6.1 | `accessPolicy` (existing courses `DIVISION_OPEN`, new courses `ENROLLMENT_REQUIRED`), enrollment grants, student queries honour policy, access changes permission-gated, confirmed and audited | M | `CourseEnrollment`, `CoursesService` |

### Phase 7 — Content publishing and versioning (ADR-010, 011) — High

| # | Step | Size | Reuses |
|---|---|---|---|
| 7.1 | Resource status + revisions + approval queue; published revision stays until approval; teachers always submit for approval | L | assignment workflow pattern |
| 7.2 | Revisions for published assignments | M | `AssignmentsService` |

### Phase 8 — Student Support and Services (ADR-012) — High

| # | Step | Size | Reuses |
|---|---|---|---|
| 8.1 | Authenticated support portal: categories, requests with reference numbers, attachments, tracking (contact form untouched) | M | storage, notifications |
| 8.2 | Staff management: assignment, priority, status, internal notes (never student-visible), responses; scoped staff | M | Phase 1 scopes |
| 8.3 | Coach meeting requests (never auto-confirmed) | S | — |

### Phase 9 — Communication groups and targeted e-mail (ADR-013, 014) — Medium/High

| # | Step | Size | Reuses |
|---|---|---|---|
| 9.1 | Revive study-groups as communication groups (codes, types, visibility, archive, invitations, owner/moderator) | M | disabled `study-groups` module |
| 9.2 | Group announcements, discussions, replies, mentions, notifications, moderation — **no private messaging** | M | discussions, moderation |
| 9.3 | Delegated group administrators (group scope) | S | Phase 1 |
| 9.4 | E-mail audiences (group, user type, country, school, subject) with preview and confirmation | S | e-mail outbox |

### Phase 10 — Notifications, audit and privacy — Medium

| # | Step | Size | Reuses |
|---|---|---|---|
| 10.1 | New notification categories/types, dedupe keys | S | `NotificationsService` |
| 10.2 | Audit diffs everywhere; new categories | S | `AuditService` |
| 10.3 | Retention for new data; purge rules; upload memory review | S | retention job |

## 3. Dependencies

```
Phase 0 ── 1 ──┬── 2 ──┬── 3 ── 6
               │       └── 5 (also needs 3.1 for subject interests)
               ├── 4 ── 5
               ├── 7 (teacher approval needs 5.1)
               ├── 8 (staff scopes need 1.3)
               └── 9 (group scope needs 1.3) ── 10
```

## 4. Estimated effort

Phase 0: ~1 week, mostly owner actions. Phases 1–10: roughly 18–19 developer-weeks
(1: 3w, 2: 2w, 3: 2w, 4: 1.5w, 5: 2w, 6: 1w, 7: 2w, 8: 2w, 9: 2w, 10: 1w), excluding frontend work, verification and decision time.

## 5. Unresolved decisions per phase

See [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md) — Phase 0: none (Q22 decided) · Phase 1: Q5, Q20 · Phase 2: Q12–Q15 · Phase 3: Q3 ·
Phase 4: Q16, Q17 · Phase 5: Q9–Q11, Q19, Q21 · Phase 7: Q7 · Phase 8: Q8 · Phase 10: Q16, Q18.

## 6. First actions

1. **Phase 0, first action:** with the owner's go-ahead to push — commit the requirements and architecture documents on `feature/backend-completion`, push the branch and open the pull request `feature/backend-completion → main` (step 0.1). Nothing is merged or deployed without approval.
2. **First implementation task (Phase 1, step 1.1), after Phase 0:** permission foundation with no behaviour change — migration `20261121000000_permission_profiles` (profile, profile-permission, user assignment, override tables), seed system profiles equal to today's `ROLE_PERMISSIONS`, assign every existing user the profile of their role, `PermissionService`, `/me/permissions` extended additively. Exit: all 482 unit + 289 e2e green; equivalence tests per role; migration rehearsed on a restored production copy; rollback instructions written.
   **Superseded 2026-11-09:** Phase 1 starts with a documentation-only decision PR (P1-01), then route declaration and role-check hardening with no behaviour change (P1-02/03); the first migration is `20261121000000_roles_teacher_head_coach_super_admin` (P1-05), not a profile table — see [docs/PHASE-1-PLAN.md](docs/PHASE-1-PLAN.md) §12.
