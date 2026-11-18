# Post-Phase-1 release: plan and execution order (both repositories)

Prepared 2026-11-17. Companion to `RELEASE-POST-PHASE1.md` (the kit) and `RELEASE-PHASE1-RUNBOOK.md` (the shared
procedures). **Nothing here is approved yet:** every step marked 🔒 changes production and needs the owner's explicit,
separate approval at the time it is run. No connection strings or credentials appear in this document.

## 0. Production today (read-only checks, 2026-11-17)

| Item | Value |
|---|---|
| Backend `main` | `b7ed2a3` (PR #50) — tree identical to the approved Phase 1 SHA `512800b` |
| Frontend `main` (Netlify) | `0b51dcc` (PR #30) |
| `_prisma_migrations` | 31 rows; all 14 Phase 1 (applied 2026-11-15 08:45–08:46 UTC); none failed or rolled back; none of the 11 below |
| Users | STUDENT 13, MENTOR 6, ADMIN 2, SUPER_ADMIN 1 — all `isActive` |
| `registration.studentSelfSignup` | `false` (set 2026-11-16 17:59 UTC by the Super Admin) → student registration is **closed** |
| `registration.teacherSelfSignup` | not set |
| Rows the new columns start empty on | MentorRequest 3, FileObject 16 |
| Live capabilities | Phase 1 set; **no** `teacherAccounts` / `headCoachAccounts` (flags not `true` on Render) |
| `post-phase1-precheck.sql` | every MUST holds (14 Phase 1 applied; 0 later; 0 failed; 0 new objects; both guards present) |

### Correction: the existing production backup

`C:\rof-backups\pre-phase1-20261116.dump` (2026-11-16 22:34, 423,107 bytes, SHA-256 `958F4853…CFE69`) was taken
**after** the Phase 1 migrations (applied 2026-11-15 08:45 UTC). Its archive contains every Phase 1 table and
trigger (`ProgrammeMembership`, `UserPermissionOverride`, `TeacherSchoolAssignment`, `StudentSchoolAffiliation`,
`SchoolContact`, `SchoolSyncRun`, `user_school_affiliation_integrity`). It is a **post-Phase-1** backup despite its
name. No pre-Phase-1 production dump exists; Phase 1 recovery is forward repair (runbook §5.3), not a restore.
The file is not renamed (its SHA-256 is recorded); the release record carries the correction.

## 1. The eleven migrations

Prisma applies them in name order. Each is additive; none deletes a row. Data impact is for production as measured
in §0.

| # | Migration | What it changes | Depends on | Production data impact | Risk | Rollback / forward repair |
|---|---|---|---|---|---|---|
| 1 | `20261201000000_teacher_applications` | enums `TeacherApplicationStatus`, `OlympiadSubject`; table `TeacherApplication` (+2 partial unique indexes: one PENDING per username / e-mail); `User.phone`, `User.country` (nullable). One transaction. | Phase 1 (`School`, `User`) | none (new table empty, new columns NULL) | low | `…teacher_applications.rollback.sql`; refuses while applications or phone/country values exist (`SET rof.teacher_applications_rollback='discard-teacher-applications'`) |
| 2 | `20261202000000_notification_outbox` | enum `NotificationOutboxStatus`; table `NotificationOutbox` (unique `dedupeKey`); `TeacherApplication.schoolVerifiedAt/ById`. One transaction. | #1 | none | low | `…notification_outbox.rollback.sql`; refuses while outbox rows exist |
| 3 | `20261203000000_student_olympiad_interests` | `User.olympiadInterests OlympiadSubject[] DEFAULT '{}'` | #1 (enum) | 22 users get `{}` (no rewrite of other columns) | low | `…student_olympiad_interests.rollback.sql`; refuses while any user has interests |
| 4 | `20261204000000_registration_details` | enum `CoachEducationLevel`; `User.dateOfBirth`, `guardianPhone`, `homeProvince/District/Sector`; `MentorRequest.country/occupation/educationLevel/olympiadInterests` | #1 (enum) | none (NULL / `{}`) | low | `…registration_details.rollback.sql`; refuses while details exist |
| 5 | `20261205000000_avatar_file_purpose` | `FilePurpose` += `AVATAR` (IF NOT EXISTS); `User.avatarFileId` (unique, FK → FileObject ON DELETE SET NULL) | — | none; existing `avatarUrl` unchanged | low. File edited before any production run (checksum note in `docs/migrations/README.md`): production never applied it, so no checksum mismatch | `…avatar_file_purpose.rollback.sql`; the enum value stays (PostgreSQL cannot drop it) |
| 6 | `20261206000000_account_states` | enum `AccountStatus`; `User.accountStatus NOT NULL DEFAULT 'ACTIVE'`; backfill `isActive=false → SUSPENDED`; table `UserStatusChange`; trigger `user_account_status_sync` (keeps `isActive = (accountStatus='ACTIVE')`, fires before `user_last_super_admin_guard`) | Phase 1 M4 guard | 22 users → `ACTIVE` (0 inactive today); Super Admin count unchanged (precheck §5 = postcheck) | medium: a trigger on `User`; rehearsed below | `…account_states.rollback.sql`; refuses while history or non-ACTIVE/SUSPENDED states exist |
| 7 | `20261207000000_bulk_operations` | enums `BulkOperationStatus`, `BulkItemOutcome`; tables `BulkOperation`, `BulkOperationItem`; indexes on `User.createdAt`, `User.gradeLevel` | — | none | low | `…bulk_operations.rollback.sql`; refuses while operations exist |
| 8 | `20261207000100_bulk_membership_guard` | function + trigger `user_bulk_membership_guard`: writes to filtered `User` columns take a shared advisory lock (8152026002) | #6 (accountStatus column) | none; ordinary writes are delayed only while a bulk operation is being created | medium: a trigger on every relevant `User` write; rehearsed below | `…bulk_membership_guard.rollback.sql` (drops function + trigger; no data) |
| 9 | `20261208000000_form_availability` | enums `FormKey`, `FormMode`; table `FormAvailability`; copies the switches | — | **STUDENT_REGISTRATION = CLOSED** (setting `false`), TEACHER_REGISTRATION = CLOSED (no setting), COACH_APPLICATION and CONTACT = OPEN — i.e. exactly today's behaviour | low | `…form_availability.rollback.sql` writes the two switches back from the forms, then drops; refuses only for schedules, custom texts or a closed coach/contact form |
| 10 | `20261209000000_application_details` | nullable application columns (position, experience, coach phone / affiliation / expertise / rejection reason), `avatarFileId` on both applications; table `ApplicationInfoRequest` (+ partial unique: one OPEN request per application); coach applications: one row per attempt — the full unique indexes on `MentorRequest.username` / `email` become partial (`status <> 'REJECTED'`), so a reapplication never inherits an earlier applicant's questions or answers (changed 2026-11-18, before any production run) | #1 | none (new table empty, new columns NULL) | low | `…application_details.rollback.sql`; refuses while information requests or new values exist |
| 11 | `20261210000000_teacher_student_access` | enums `TeacherStudentSource`, `DelegationStudentScope`; tables `TeacherStudentAssignment`, `UserPermissionOverrideStudent`; `UserPermissionOverride.studentScope / reviewNeededAt / reviewReason`; teacher delegation GRANTs → `SCHOOL`; CHECKs (no self-assignment, cross-school reason, scope only on delegations) | Phase 1 M5 / M6 | **0 rows** updated (production has no teacher delegation, measured 2026-11-18) | low | `…teacher_student_access.rollback.sql`; refuses while assignments / selections / narrowed delegations exist; discard mode revokes narrowed delegations (never widens) |

**Never edited by a rollback:** `_prisma_migrations`. Removing the history rows is its own reviewed step after the
objects are confirmed gone (`rehearsal.mjs rollback-history` checks this).

**Forward repair (preferred over rollback after users have acted):** keep the schema, deploy a fix to the
application. Rollback is only for a failure before or immediately after the deploy, while the data guards are still
silent.

## 2. Rehearsal on a Neon branch of production (never production)

The earlier rehearsal branch (`ep-square-mountain-…`) can no longer be used: password authentication for its owner
role fails (rotated). A **fresh** branch gives the most representative data (production of today).

Owner action (Neon console; copy-on-write, does not touch the production branch):
1. Create branch `post-phase1-rehearsal-<date>` from the production branch, **current data**, with its own
   compute endpoint.
2. Put its **direct** (non-pooled) connection string in `.env.drill.local` of the release checkout as
   `DRILL_DATABASE_URL=…` (only key). The release checkout also needs `.env.production.local` for the guard (it
   refuses the production host).

Then, from the release checkout pinned to the approved SHA (`C:\rof-release-<sha>`, fresh clone, `npm ci`,
`npx prisma generate`):

```
node scripts/release/rehearsal.mjs check-target --release post-phase1                    # guard passes, no connection
node scripts/release/rehearsal.mjs precheck     --release post-phase1                    # every MUST holds; save output
node scripts/release/rehearsal.mjs status       --release post-phase1                    # exit 1: the eleven not yet applied
node scripts/release/rehearsal.mjs deploy       --release post-phase1 --confirm <ep-id>  # exit 0; record duration
node scripts/release/rehearsal.mjs diff         --release post-phase1                    # exit 0: "No difference detected"
node scripts/release/rehearsal.mjs postcheck    --release post-phase1                    # every MUST; compare lines = precheck
node scripts/release/rehearsal.mjs rollback     --release post-phase1 --confirm <ep-id>  # all eleven roll back (data still empty)
node scripts/release/rehearsal.mjs rollback-history --release post-phase1 --confirm <ep-id>
node scripts/release/rehearsal.mjs status       --release post-phase1                    # the eleven again, exit 1
node scripts/release/rehearsal.mjs deploy       --release post-phase1 --confirm <ep-id>  # re-deploy works (AVATAR IF NOT EXISTS)
node scripts/release/rehearsal.mjs postcheck    --release post-phase1
```

Expected (from production's numbers): users per role unchanged and all `ACTIVE`; 1 active Super Admin before and
after; forms STUDENT_REGISTRATION CLOSED, TEACHER_REGISTRATION CLOSED, COACH_APPLICATION OPEN, CONTACT OPEN;
triggers `user_account_status_sync` and `user_bulk_membership_guard` present and enabled; new tables empty.

**Application test on the rehearsal branch:** run the release candidate locally against the branch
(`DATABASE_URL` = the branch, `NODE_ENV=production`, `WORKERS_ENABLED=true`, mail to a sink) and check:
`GET /health` (database up), `GET /api/v1` (features now include `accountStates`, `bulkUserOperations`,
`formAvailability`, …; `teacherSelfRegistration` only with `TEACHERS_ENABLED=true`), `GET /api/v1/forms` (states above), and with a **synthetic**
Administrator created on the branch (never a real account): `GET /admin/forms`, a bulk preview (changes nothing),
`GET /admin/users/:id/status-history`. Delete the branch afterwards.

**Restore drill (the untested risk from Phase 1):** on the same branch, in an *empty* database
(`CREATE DATABASE restore_drill;`, a second `.env.drill.local` URL pointing to it), run
`rehearsal.mjs restore --release post-phase1 --dump C:\rof-backups\<new dump>` and confirm row counts per table
equal the dump's. This turns the "recovery procedure untested" risk into a tested one.

## 3. New production backup procedure (before the migration) 🔒

Run from the release checkout, in an EFS-encrypted folder outside OneDrive and outside the repository
(`C:\rof-backups`; `checkDumpDir` refuses anything else). PostgreSQL 18 tools
(`C:\Program Files\PostgreSQL\18\bin`; add to `PATH` for the session). The password comes from `pgpass.conf`, never
the command line.

1. **Neon branch snapshot** (instant, keeps the pre-release state on the server):
   Neon console → Branches → create `pre-post-phase1-<date>` from production, current data. Record the time.
2. **Logical dump** (`RELEASE-PHASE1-RUNBOOK.md` §2.1):
   `pg_dump --format=custom --no-owner --no-acl --file C:\rof-backups\pre-post-phase1-<date>.dump <direct conninfo>`
3. **Verify** — record in the release record:
   - size and `Get-FileHash -Algorithm SHA256`;
   - `pg_restore --list` succeeds; `TABLE DATA` count; the archive contains `ProgrammeMembership` (Phase 1) and does
     **not** contain `FormAvailability` / `UserStatusChange` / `BulkOperation` (i.e. it is the pre-release state);
   - `(Get-Item …).Attributes` contains `Encrypted`.
4. **Restore drill** of that dump into an empty database on the rehearsal branch (§2), row counts compared.
5. Keep the dump until the release has been stable for 30 days; the EFS certificate stays backed up off the machine.

## 4. Feature flags (Teacher and Head Coach) — exact Render steps 🔒

The code accepts exactly `true` or `false` (lower case; anything else stops the service at start-up). The flags are
not in `render.yaml`, so they live only in the Render dashboard and a Blueprint sync does not change them. Today the
live API does not advertise `teacherAccounts` / `headCoachAccounts`: the values are unset or `false`.

**Owner instruction (2026-11-17): do not enable them merely because the implementation is ready.** When the owner
approves enabling:

1. Render → `rof-lms-api` → Environment.
2. Set `TEACHERS_ENABLED` = `true` and `HEAD_COACHES_ENABLED` = `true` (type the value; no quotes, no spaces).
   Leave `SUPER_ADMIN_BOUNDARY_ENABLED` = `false`.
3. **Save, rebuild and deploy** (a plain "Save" does not restart the service; the running process keeps the old
   values — the likely reason the 16 Nov decision is not live).
4. Verify: `GET https://rofbackendtest.onrender.com/api/v1` → `capabilities.features` contains `teacherAccounts` and
   `headCoachAccounts`, and after the post-Phase-1 release also `teacherSelfRegistration`.
5. Teacher **registration** stays closed until an Administrator opens the form (Forms page or the Settings switch).

Rollback: set both to `false`, save, rebuild and deploy. Existing TEACHER / HEAD_COACH accounts keep their role;
only new assignments of those roles are refused.

## 5. Moving `.env.production.local` out of OneDrive (owner action, recommended now)

The backend working copy under `OneDrive\Documents` holds `.env.production.local` (production database
credentials). It is git-ignored, but OneDrive uploads it to the cloud and keeps versions.

1. Create `C:\rof-secrets` (outside OneDrive), then encrypt it: `cipher /e C:\rof-secrets`.
2. Copy, do not move yet: `Copy-Item <OneDrive path>\.env.production.local C:\rof-secrets\` and compare
   `Get-FileHash` of both (same hash = same content; nothing is printed).
3. Point tools at the new place: the release checkouts already hold their own copy; nothing in the repository reads
   the OneDrive copy.
4. Delete the OneDrive copy, then **empty it from the OneDrive recycle bin and online version history**
   (onedrive.live.com → Recycle bin; the file's Version history).
5. Because the file has been in the cloud, **rotate** the `neondb_owner` password in Neon (production branch), then
   update Render's `DATABASE_URL` / `DIRECT_DATABASE_URL` and the local copies — a separate, approved change 🔒
   (Render redeploy; brief restart).

## 6. Release execution order

Each 🔒 step needs its own approval at the time. "Verify" lists the command and the expected result. Avoid
22:00–24:00 UTC.

| # | Step | Verify | If it fails |
|---|---|---|---|
| 1 | Backend PRs into `develop`, in order: #61 `fix/role-notification-settings` → #62 `feat/applications-complete` → #63 `feat/teacher-student-access` (stacked) → #64 `docs/post-phase1-release-plan` | CI `test` + `compose-smoke` green on the PR and on `develop` | fix on the branch |
| 2 | Frontend PRs into `develop`, in order #31 → #40 (each step merges cleanly; integration verified in the final review: typecheck, lint, unit tests, Netlify build, Playwright 20/20) | CI green on every PR head and on `develop` | fix on the branch |
| 3 | Approve the release SHAs: backend `develop` HEAD and frontend `develop` HEAD after 1–2 | record both 40-character SHAs | — |
| 4 | Fresh Neon rehearsal (§2) incl. application test and restore drill | every MUST; diff exit 0; rollback + re-deploy clean | stop; investigate on the branch |
| 5 🔒 | Freeze (no account, school or setting changes); pause Render auto-deploy | — | — |
| 6 🔒 | Backup (§3) | hash, `pg_restore --list`, encryption recorded | stop |
| 7 🔒 | `psql -X -v ON_ERROR_STOP=1 -f scripts/release/post-phase1-precheck.sql` | every MUST holds; save output | stop |
| 8 🔒 | `npx prisma migrate deploy` (release checkout, production `DIRECT_DATABASE_URL`) | lists exactly the eleven; exit 0 | old code keeps running (all additive); investigate; rollbacks only with approval |
| 9 🔒 | `post-phase1-postcheck.sql`; `npx prisma migrate status`; `migrate diff --exit-code` | MUSTs hold; "Database schema is up to date"; exit 0 | forward repair or §1 rollbacks |
| 10 🔒 | Merge frontend `develop` → `main` FIRST (Netlify publishes). Against the old backend it changes nothing visible (new screens check capabilities; the date-of-birth step needs the backend flag), except Head Coach notification switches, which show an error until step 11 | Netlify Published = that SHA; sign-in works | Netlify "Publish deploy" of the previous deploy |
| 11 🔒 | Merge backend `develop` → `main` (the deploy; Render manual deploy if auto-deploy is paused). Never before step 10: the backend holds students without a date of birth until they give it, and only the new frontend shows that step | `GET /health` 200 `database: up`; `GET /api/v1` features include `studentDateOfBirthStep`, `dateOfBirthCorrection`, `applicationPictureReview`, `teacherStudentAccess`; a student without a date of birth sees the step; `git diff origin/main <approved SHA>` empty. Then check client addresses (render.yaml TRUST_PROXY note: browsers reach the API through Netlify, so with TRUST_PROXY=1 every unauthenticated request may share one rate-limit address — verify in the logs and, with approval, set 2) | redeploy the previous backend (schema stays: additive); run the 1210 pre-switch step first if narrowed delegations exist (runbook §4) |
| 12 🔒 | Smoke tests with the owner's own accounts only (no real users): admin sign-in, `/admin/forms`, a bulk **preview** (no execute), a user's account history, notification settings | as listed | as above |
| 13 🔒 | Lift the freeze; resume auto-deploy | — | — |
| 14 🔒 | Separately approved: Teacher / Head Coach flags (§4); opening teacher registration on the Forms page | `teacherAccounts`, `headCoachAccounts` in capabilities | §4 rollback |

Rollback deadline: 60 minutes after step 10. After users have acted on the new features, prefer forward repair.
