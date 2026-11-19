# Staging environment and Neon restore drill (2026-11-18, revised for the staging run)

Written for: the owner (account actions) and whoever runs the drill.

**Release gate:** before the production release, the owner decided on 2026-11-18 that the following must succeed: a
Neon restore, the migration checks, an application test on the restored data, the rollback rehearsal and the
client-IP probe.

- Nothing here uses production credentials or writes to production.
- Steps marked 🔑 need the owner's Neon, Render or Netlify account. Everything else is done by the developer.
- No secret appears in chat, in reports or in logs. That covers connection strings, `JWT_SECRET` and passwords.

## 1. What staging is

| Part | Staging | Isolation |
|---|---|---|
| Database | a **Neon branch** of the production project (copy-on-write) with its own role `staging` | writes to the branch never reach production; the `staging` role exists only on the branch |
| Backend | a separate Render web service `rof-backend-staging` built from the release head, **auto-deploy off** | its own URL, its own new `JWT_SECRET`, `DATABASE_URL` set to the branch, no e-mail key, local storage |
| Client-IP probe | a separate Render web service `rof-client-ip-probe` (no database, no variables) | stores and logs nothing |
| Frontend | a Netlify branch deploy, or a second site, with `API_PROXY_TARGET` set to the staging backend | its own URL |
| File storage | `STORAGE_DRIVER=local` (temporary disk) | never the production bucket |
| E-mail | dry run: `EMAIL_DRY_RUN=true` and no `RESEND_API_KEY`, so messages are logged and not sent | nobody receives anything |

**The branch is a copy of sensitive production data, including minors.**
- Share the staging URLs and the branch only with the people running the drill. Use Netlify site password protection if
  your plan includes it.
- Don't invite or e-mail anyone, and never sign in as a real user. The application test uses two **synthetic accounts**
  created in the branch only (`scripts/release/staging-accounts.mjs`): `staging.drill.*` usernames and `@staging.invalid`
  e-mail addresses.
- Delete the branch and all staging services right after the drill (§5).

## 2. Owner actions 🔑 (about 20 minutes)

Release head to stage: **backend `feat/teacher-student-access`** (PR #63, which contains #61 and #62; the exact SHA is in
`FINAL-REVIEW-PACKAGE.md` §1). For the frontend, use the integrated frontend once merged, or the head of PR #40.

1. **Neon** → production project → **Branches → Create branch**.
   - Base it on `main` **at a point in time about 10 minutes ago**. This also exercises point-in-time restore.
   - Name it `restore-drill-<date>`.
   - Never choose "reset" or "restore" on `main`.
2. **Neon** → the new branch → **Roles → New role** `staging`. This is the application's runtime role; do not reuse the
   production role.
   - `staging` can read and write the data but cannot run migrations: tables and types belong to `neondb_owner`
     (run 2). A grant is not possible either: Neon refuses to grant `neondb_owner` membership (run 2, the owner's
     attempt).
   - **Migrations therefore run as the branch's `neondb_owner`.** A branch copies its parent's role passwords, so first
     reset `neondb_owner`'s password **on the branch**: in Neon, check that the branch selector shows
     `restore-drill-…` and **not `main`**, then Roles → `neondb_owner` → Reset password.
   - Resetting it on `main` would break production's connection, so check the branch name before confirming.
   - The kit refuses an owner string that still carries production's password. The comparison is made in memory and
     nothing is printed.
3. **Render → New → Web Service** `rof-backend-staging`, from repository `ROFBACKENDTEST`, branch
   `feat/teacher-student-access`, with **Auto-Deploy: No**. **Before the first deploy**, enter all its environment
   variables on the creation page:
   - `DATABASE_URL` and `DIRECT_DATABASE_URL`: the **branch's** pooled and direct strings for role `staging`. Check that
     the host starts with the **branch** endpoint id (`ep-…`) and not production's. Production's endpoint id is in your
     production Render service; compare them.
   - `JWT_SECRET`: a new random value of 64 characters or more. Never copy production's.
   - `NODE_ENV=production`, `TRUST_PROXY=1`, `STORAGE_DRIVER=local`, **`EMAIL_DRY_RUN=true`**, and **no** `RESEND_API_KEY`
     or `EMAIL_FROM`. `EMAIL_DRY_RUN` needs backend #62 `c1fad79` or later, which #63 contains. Without it, production
     mode refuses to start unless an e-mail key is present, and a key on a copy of real data can reach real people.
   - **Do not deploy it yet.** The branch must be migrated first (§3 step 2): the release code fails on the old schema,
     with sign-in and forms returning 500 (run 1).
   - `TEACHERS_ENABLED` and `HEAD_COACHES_ENABLED`: the same values as production.
   - `APP_URL` and the CORS origin: the staging site URL from step 5. Set them after step 5 if needed, then redeploy
     manually.
   - Nothing else from production: no storage keys, no e-mail key, no monitoring or webhook URLs.
4. **Render → New → Web Service** `rof-client-ip-probe`, from the same repository and branch, start command
   `node scripts/ops/client-ip-probe.mjs`, **no environment variables**, auto-deploy off.
5. **Netlify** → the frontend site → **Branch deploys**, or a new site from the same repository:
   - set `API_PROXY_TARGET` to the staging backend URL;
   - do not attach the production domain;
   - turn on password protection if available.
6. **Hand over the database access without chat.** On the drill computer, create the file
   `C:\rof-audit\be-ts\.env.drill.local`, which is git-ignored, with two lines:
   - `DRILL_DATABASE_URL=<the branch's direct connection string for role staging>`, used by the read-only checks and
     the synthetic accounts;
   - `DRILL_MIGRATION_DATABASE_URL=<the branch's direct connection string for role neondb_owner, after the reset in
     step 2>`, used only for status, deploy, diff, rollback and rollback-history.

   The kit (#63 `6e78c2b` or later) accepts the owner string only if it passes the production guard, is on the
   **same endpoint** as the first line, and does not carry a production password.
7. **Send the developer, in chat:**
   - the staging site URL;
   - the staging backend URL;
   - the probe URL;
   - the branch endpoint id (`ep-…`);
   - your own public address, if you take part in the client-IP test from a second network.

   **No passwords or connection strings.**

## 3. Drill (developer; branch only; each step's result is recorded in §6)

The release kit and `staging-accounts.mjs` both:
- refuse any target whose host or endpoint id is production's. Production's host is read from the existing
  git-ignored `.env.production.local`, which is copied into the worktree **for this comparison only** (it is never
  connected to) and deleted afterwards;
- write nothing without `--confirm <ep-id>` matching the branch.

0. **Isolation pre-flight (before any write).**
   - `rehearsal.mjs check-target` shows the guard passes and that the endpoint is the branch id the owner sent.
   - `rehearsal.mjs status --release post-phase1` shows the branch holds the production migration history with the
     eleven not yet applied.
   - Read-only row counts on the branch: users by role, schools, applications.
   - The staging backend and site answer, and the site's `/api/v1` is served by the staging backend, not production.
1. **Restore check.**
   - `post-phase1-precheck.sql` on the branch: every MUST holds.
   - The counts are plausible for production at the chosen point in time: no table empty that should not be, and the
     newest rows are older than the branch point.
2. **Migrations.**
   - `rehearsal.mjs deploy --release post-phase1 --confirm <ep-id>` applies the eleven.
   - `post-phase1-postcheck.sql`: every MUST holds.
   - `migrate diff`: exit 0, meaning no drift.
3. **Staging backend on the migrated branch.**
   - 🔑 or developer if given access: trigger a manual deploy of `rof-backend-staging` at the release SHA.
   - Then run `staging-accounts.mjs create --confirm <ep-id>`.
   - **Isolation proof:** the synthetic Administrator signs in on the **staging site**. The account exists only in the
     branch, so the staging backend reads the branch.
4. **Application test on the restored data, with synthetic accounts only.** Record each result.

   As the Administrator:
   - the dashboard loads;
   - the user list loads, with phone numbers masked and no dates of birth shown;
   - the Forms page;
   - a bulk preview, using a dry run only and without committing;
   - the School Access page;
   - the coach applications page;
   - a real student's picture is never shown in the list.

   As the synthetic student:
   - sign-in shows the date-of-birth step, entering it once reaches the portal, and a second change is refused;
   - sign-in limits: 5 wrong passwords from one network lock the account there; the `LOCK_ACCOUNT` audit shows that
     network's **public** address; the right password works from a second network.
5. **Client-IP probe** (`CLIENT-IP-VERIFICATION.md` §3).
   - 🔑 Point the staging site's `API_PROXY_TARGET` at the probe and redeploy the site. Afterwards, point it back.
   - Calls from two networks, plus a call with a forged `X-Forwarded-For`, establish whether the backend sees the
     visitor's address or Netlify's, and whether a visitor can forge it.
6. **Rollback rehearsal.**
   - `…teacher_student_access.pre-switch.sql`;
   - then `rehearsal.mjs rollback` (all eleven, newest first);
     if a guard stops it (as on 2026-11-19), run the same command again — with `--acknowledge <id>` only if approved;
     the migrations already rolled back are skipped (RELEASE-POST-PHASE1.md §1);
   - then `rollback-history`;
   - then `status` (the eleven pending again);
   - then `deploy` again and the post-check again.
7. **Clean-up.**
   - `staging-accounts.mjs disable --confirm <ep-id>`.
   - Delete `.env.drill.local`, the copied `.env.production.local` and `.env.staging-accounts.local` from the worktree.

## 4. Stop conditions

Stop and report, writing nothing further, if any of the following happens:
- a guard refuses;
- the endpoint id differs from the one the owner sent;
- the branch already records any of the eleven migrations;
- a MUST fails;
- the synthetic Administrator cannot sign in on staging. That could mean the backend is reading another database.

## 5. Afterwards 🔑

- Delete the two Render staging services, the Netlify branch deploy or site, and the Neon branch (Neon → Branches →
  delete).
- Remove the drill computer's `.env.drill.local` if it is still present.
- Production credentials were never used, so nothing in production needs rotating.

## 6. Results

### Run 1 — 2026-11-18, 13:27–13:50 UTC (staging backend `rof-backend-staging.onrender.com`, deployed at `ceae3e0`)

Only unauthenticated, read-only requests were possible: `.env.drill.local` was not provided, so the branch database
could not be reached. Nothing was written anywhere.

| Gate | Result | Evidence |
|---|---|---|
| Staging backend reachable, release code | PASS | `/health` → `{"status":"ok","database":"up","storage":"up"}`; `/api/v1` lists the release capabilities (`dateOfBirthCorrection`, `applicationPictureReview`, …) |
| Backend connected to branch `restore-drill-2026-11-18` with role `staging` | BLOCKED | Cannot be established from outside. The database currently has production's pre-release schema, so it is either the branch or production. The proof (§3 step 3: a synthetic account that exists only in the branch signs in) needs `.env.drill.local`. |
| The eleven migrations applied | **FAIL** | The database is **not migrated**. `GET /api/v1/forms` → 500 (needs `FormAvailability`, migration 1208); `POST /auth/login` → 500 for every request (needs `User.accountStatus`, migration 1206). Reproduced locally with the same build: a database at production's schema gives the same two 500s ("table `public.FormAvailability` does not exist", "column `User.accountStatus` does not exist"); a migrated one gives 200. Cause: the backend was deployed **before** §3 step 2. The procedure order is correct, so this is not a code defect. |
| Synthetic accounts only on the branch | BLOCKED | Not created; needs `.env.drill.local`, and the branch migrated first (their columns arrive with the migrations). |
| Application and integration tests | BLOCKED | Sign-in fails until the branch is migrated. |
| Rollback rehearsal | BLOCKED | Needs `.env.drill.local`. |
| Client-IP probe through Netlify | BLOCKED | The service `rof-client-ip-probe.onrender.com` does not exist (404), and no staging site URL was given. |
| Client address, direct to Render (`TRUST_PROXY=1`) | **FAIL (finding)** | One client, sequential requests: 70 sign-ins without a 429. The limit of 60 per address is fixed in code, and the same build locally refuses at the 61st. `GET /api/v1` from one client: no 429 in 125 requests; 600 requests in under a minute were first refused at about the 450th, where one address would be refused at the 121st. **On Render, `req.ip` is not the visitor's address**: it varies between requests, which suggests Render's or Cloudflare's proxy addresses. Several service instances, each with its own in-memory counters, would look the same; the probe will tell which. Forged `X-Forwarded-For` values did not raise the limits further (no evidence of forging). |
| E-mail | **FAIL (configuration)** | `NODE_ENV=production` refuses to start without `RESEND_API_KEY` and `EMAIL_FROM`, so this staging service has a live e-mail key. Unless `EMAIL_REDIRECT_TO` is set, its e-mail worker may already have delivered e-mails from the copied outbox to real people. **Fix:** `EMAIL_DRY_RUN=true` (backend #62 `c1fad79`, in #63 `9d58ebd`): production mode with no e-mail key, nothing ever sent, a warning at every start. Verified locally. |
| Storage | PASS (limited) | `/health` storage `up`. `STORAGE_DRIVER=local` is a temporary disk: files uploaded on staging disappear at every deploy or restart, and the production bucket's files (pictures, submissions) are **not** in staging. Downloads of existing files return 404 there; that is expected and not a defect. |

**Owner actions to continue** (§2):
- Set `EMAIL_DRY_RUN=true` and remove `RESEND_API_KEY` on the staging service.
- Confirm that its `DATABASE_URL` host does **not** start with production's endpoint id `ep-orange-sun-bdrp42oo`.
- Create `.env.drill.local`.
- Deploy the probe and the Netlify staging site, and send their URLs.

Then: §3 steps 0–2 (migrate the branch), redeploy staging at the current #63 head, and steps 3–7.

### Run 1 follow-up — 2026-11-18, after the owner's changes

- **Owner (done):**
  - the staging service is suspended;
  - `RESEND_API_KEY` is removed and `EMAIL_DRY_RUN=true` added;
  - the staging-only Resend key is revoked;
  - production's key and services are untouched.
- **Deploy target verified:** branch `feat/teacher-student-access`, commit **`9d58ebdbaba9ef329945df2a39bda1253e3040d9`**.
  - It is the remote head and contains the dry-run fix `c1fad79`.
  - GitHub CI passed ([run 44316601659](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44316601659)), and the CI replica passes every step.
- **Startup verified locally on that build.** The environment was production mode, `TRUST_PROXY=1`, local storage,
  `EMAIL_DRY_RUN=true` and no `RESEND_API_KEY`, run once with and once without `EMAIL_FROM`.
  - It started with health ok and logged the warning "EMAIL_DRY_RUN=true: NO e-mail is sent".
  - It never initialised Resend, and logged no errors.
  - Control: the same environment without `EMAIL_DRY_RUN` refuses to start.
- **Start-up runs no migrations.** The Dockerfile's default stage runs `node dist/main.js` only; `render.yaml` is the
  production service on `main` and is not used by staging.
- **Do not "Resume" the service.** That restarts the last build, `ceae3e0`, which predates `EMAIL_DRY_RUN` and now
  refuses to start. After the branch is migrated (§3 step 2), use **Manual Deploy → Deploy a specific commit →
  `9d58ebd`**.
- **Next owner action:** §2 step 6, `C:
of-audite-ts.env.drill.local`. Done for run 2.

### Run 2 — 2026-11-18, about 14:30 UTC (branch endpoint `ep-orange-mountain-bd28w4ro`, checkout `9d58ebd`)

| Step | Result | Evidence |
|---|---|---|
| Endpoint is the branch, not production | PASS | `.env.drill.local`: one entry, endpoint `ep-orange-mountain-bd28w4ro` (as the owner sent), direct, role `staging`, database `neondb`. Production's endpoint is `ep-orange-sun-bdrp42oo`, which is different. |
| Production guard | PASS | `check-target`: "guard passed. No connection made." Both env files are git-ignored. |
| Eleven pending | PASS | `status`: 42 migrations in the checkout; exactly the eleven post-Phase-1 migrations not applied. |
| Pre-check (read-only) | PASS | All MUSTs: 14 Phase 1 migrations applied, 0 post-Phase-1, none failed; 0 of the new objects; both guard triggers enabled. Compare values: users STUDENT 13 / MENTOR 6 / ADMIN 2 / SUPER_ADMIN 1, all active; 1 active Super Administrator; `studentSelfSignup=false`; 3 coach applications. These match the production pre-check recorded on 2026-11-17, except file objects: 15 now against 16 then. |
| Apply the eleven migrations | **FAIL, nothing applied** | The first migration (`…teacher_applications`) failed with "current transaction is aborted". Cause, from read-only queries: role `staging` owns nothing (62 tables and 45 enums belong to `neondb_owner`), has no CREATE on `public`, and is not a member of `neondb_owner`. This is a permissions problem, not a migration defect. It has full read and write access to the data, which is enough for the app at runtime. |
| Clean-up of the failed attempt | PASS | Re-check: 0 of the new objects exist. `rollback-history` (guarded, `--confirm`) deleted the 1 failed history row. Pre-check again: every MUST holds. The branch is back to its exact pre-migration state. |
| Post-check, drift check | NOT RUN | They follow a successful deploy. |

**Next owner action:** §2 step 2's grant on the branch. Then the developer reruns `deploy`, `postcheck` and `diff`.

### Run 3 preparation — after the grant was refused

- The owner's `GRANT neondb_owner TO staging` was refused by Neon ("Only roles with the ADMIN option on role
  'neondb_owner' may grant this role"). The grant is abandoned.
- **Change:** the kit (#63 `6e78c2b`) takes an optional `DRILL_MIGRATION_DATABASE_URL`, the branch owner, used only for
  the schema and history commands. The production guard is unchanged and applies to it too. Three checks are added:
  - the same endpoint and host as `DRILL_DATABASE_URL`;
  - no production password;
  - exactly one entry.
- Tests: 3 new; all release and ops script tests 155/155. Live `check-target` without the new line: unchanged
  ("role: staging").
- Read-only pre-check rerun: every MUST still holds; the values are as in run 2. **Nothing applied.**
- **Next owner action:** §2 step 2's password reset on the branch and §2 step 6's second line. Then the developer runs
  `check-target` (it must name role `neondb_owner`, the same endpoint, and "production password check passed"),
  `status`, `deploy`, `postcheck` and `diff`.

### Run 3 — 2026-11-18, about 15:00 UTC (kit `6e78c2b`, CI [run 44328300738](https://github.com/Theoneste1/ROFBACKENDTEST/actions/runs/44328300738))

| Step | Result | Evidence |
|---|---|---|
| Both connections on the branch, same endpoint | PASS | `DRILL_DATABASE_URL`: `ep-orange-mountain-bd28w4ro`, direct, role `staging`. `DRILL_MIGRATION_DATABASE_URL`: `ep-orange-mountain-bd28w4ro`, direct, role `neondb_owner`. Both use database `neondb` and have one entry each. Production is `ep-orange-sun-bdrp42oo`. |
| Owner password is not production's | PASS | Compared in memory: false. The kit reports "production password check passed". |
| Production guard | PASS | `check-target`: guard passed, no connection; the migration role is on the same endpoint. |
| Pending migrations (status, as owner) | PASS | Exactly the eleven post-Phase-1 migrations not applied. |
| Pre-check (read-only, as `staging`) | PASS | Every MUST; the values are as in runs 2 and 3. |
| **Apply the eleven** (`deploy`, as owner, `--confirm`) | **PASS** | "All migrations have been successfully applied." Exit 0, 66 s. |
| **Post-check** (read-only) | **PASS** | All MUSTs hold. 14 + 11 applied, nothing failed or later. New objects: 9 tables, 11 enums, 24 columns, 2 triggers, the AVATAR purpose. Account states: 0 exceptions. Users 13/6/2/1 and 1 Super Administrator, equal to the pre-check. Forms: student registration CLOSED (the old switch was `false`), teacher CLOSED, coach and contact OPEN, default texts. The new tables are empty; 0 delegations not school-wide. Four triggers enabled. |
| **Schema drift** (`diff`) | **PASS** | "No difference detected", exit 0. `status`: "Database schema is up to date!" |
| Runtime role on the new objects | PASS | `staging` has SELECT, INSERT, UPDATE and DELETE on all 9 new tables. 0 tables, sequences, enums or functions lack its access. The new tables belong to `neondb_owner`, as in production. |

**Next owner action:** Render → `rof-backend-staging` → **Manual Deploy → Deploy a specific commit → `6e78c2b`**. Its app code
is identical to `9d58ebd`; only the kit changed. Do **not** use Resume. Then the developer runs §3 step 3, the synthetic accounts and the isolation proof.

### Incident — 2026-11-18, about 15:05–15:32 UTC: the staging commit was deployed to the production service

**What happened**
- The manual deploy of `6e78c2b` was made on the **production** Render service (ROFBACKENDTEST, branch `main`), not on
  `rof-backend-staging`.
- Detected by read-only checks:
  - the staging URL answered 503 "suspended";
  - the production API (`rofbackendtest.onrender.com`) listed the release features (`dateOfBirthCorrection`,
    `bulkUserOperations`, …), which do not exist on `main`;
  - production answered 500 on `/api/v1/forms`, because the release code ran on the unmigrated production database.
- The owner rolled production back to `b7ed2a3`; it was live again at 15:32 UTC.

**Recovery verification** (read-only; no sign-in, no write; 15:35 UTC)

| Check | Result |
|---|---|
| `/health` | `ok`; database `up`, storage `up` |
| Features (`/api/v1`) | 9, exactly the "always" set of `b7ed2a3`; no release-only feature. `teacherAccounts` and `headCoachAccounts` are absent, so the production flags are still off. |
| `/api/v1/forms` | 404 "Cannot GET", as expected: that version has no such route (not 500) |
| Public endpoints | `divisions`, `public/statistics`, `schools/locations`, `schools/search`: 200 with data. `admin/settings` without sign-in: 401, as expected. |
| Database (READ ONLY transaction; aggregates only) | Migration history: 31 applied, 0 failed, 0 post-Phase-1 entries; latest `20261121001300_school_directory_sync_approval`. None of the release's tables, columns or triggers exist. |
| Writes during the incident (14:55–15:35 UTC) | 0 audit rows, 0 e-mail delivery attempts, 0 users created or updated. Today's only audit rows are at 04:00 and 11:00 UTC. |
| Environment variables | Not readable from here. Deploying a commit does not change them, and the owner changed none. To be confirmed by the owner in Render (production service → Environment, and Events show no environment change). |

**Prevention.** Before any staging deploy or setting change, check that the Render page header reads
**`rof-backend-staging`** and that its URL is `rof-backend-staging.onrender.com`. Check that this service's branch is
`feat/teacher-student-access` (the `main` label in the incident came from the production service) and that auto-deploy is off. After a deploy, the developer checks
that `rof-backend-staging.onrender.com/api/v1` lists the release features **and** that production's `/api/v1` still does
not.

### Staging deployment verification — 2026-11-18, 15:56 UTC (read-only)

Service `rof-backend-staging` (`srv-dbuq9fm7bikc73an3gb0`), branch `feat/teacher-student-access`, commit `6e78c2b` (as Render reports).

| Check | Result | Evidence |
|---|---|---|
| Health | PASS | `{"status":"ok","checks":{"database":"up","storage":"up"}}` |
| Built from `6e78c2b` | PASS (consistent; the SHA is not exposed by the API) | 23 features = exactly the 23 "always" features of `6e78c2b`'s `src/app/capabilities.ts`; the 3 flag-gated features are absent, so the flags are off, as in production. The API does not report a commit, and `9d58ebd`…`6e78c2b` have identical app code, so the exact SHA rests on Render's deploy record. |
| Release features and routes | PASS | Release features present (`dateOfBirthCorrection`, `formAvailability`, `accountStates`, `bulkUserOperations`, `teacherStudentAccess`, …). `/api/v1/forms` 200: STUDENT_REGISTRATION closed, TEACHER_REGISTRATION closed, COACH_APPLICATION open, CONTACT open. |
| Database = branch `ep-orange-mountain-bd28w4ro`, role `staging` | PASS | (1) `/forms` returns exactly the branch's post-check rows; production has no `FormAvailability` table and returns 404 or 500. (2) During staging traffic, the branch's `pg_stat_activity` shows 3 sessions of role `staging` through `pgbouncer`, the pooled connection. The checker connects directly, is excluded, and has `pg_read_all_stats`. |
| `EMAIL_DRY_RUN=true`, no `RESEND_API_KEY` | NOT VERIFIABLE READ-ONLY | The API exposes neither, and the startup log is in Render. Owner to confirm on the Environment page (names only) and in the deploy log line "EMAIL_DRY_RUN=true: NO e-mail is sent (staging)". Mitigations already in place: the staging-only key is revoked, and the branch has 0 pending e-mail deliveries. |
| Production unaffected | PASS | `/health` ok (database and storage up); 9 features = `b7ed2a3`'s "always" set; `/forms` 404. |

### Synthetic accounts and isolation proof — 2026-11-18, about 16:05 UTC (§3 step 3; owner authorization after confirming e-mail safeguards)

Owner-confirmed before the step, in Render for `rof-backend-staging`:
- `EMAIL_DRY_RUN=true` and no `RESEND_API_KEY`;
- the startup log shows "EMAIL_DRY_RUN=true: NO e-mail is sent (staging)" and not "E-mail delivery via Resend".

| Check | Result | Evidence |
|---|---|---|
| Pre-write safety | PASS | Kit `6e78c2b`. Guard passed with no connection. Runtime connection on `ep-orange-mountain-bd28w4ro` as role `staging`. 0 existing `staging.drill.*` or `@staging.invalid` users, no accounts file. Users 13/6/2/1. Staging health ok. |
| Accounts created (`staging-accounts.mjs create --confirm ep-orange-mountain-bd28w4ro`) | PASS | `staging.drill.admin-d37686` (ADMIN) and `staging.drill.student-d37686` (STUDENT, no date of birth). Both have `@staging.invalid` e-mail, are ACTIVE, approved and activated, have a password set, and have 0 permission overrides. Passwords are only in the git-ignored `.env.staging-accounts.local` and were never printed. Users now 14/6/3/1: exactly +1 student and +1 Administrator. |
| **Isolation proof: Administrator sign-in on staging** | **PASS** | `POST rof-backend-staging…/auth/login` returned 200 with role ADMIN and a token. `/me` returned 200 for `staging.drill.admin-d37686` with role ADMIN. The staging Administrator user list finds both accounts. They exist only on the branch, so the staging backend reads the branch. |
| Writes caused | PASS (as expected) | The 2 account rows, then from the sign-in: 1 `LOGIN` audit row, 1 session, and `lastLoginAt` for the Administrator. No other audit row in the 15-minute window, and 0 e-mail deliveries created. The student account has not been used. |
| Production untouched | PASS (by construction) | Neither the production database nor the production service was accessed in this step (owner's rule). Every write went through the guarded branch connection, and production's host is only compared as a string. Last read-only production verification: 15:35 and 15:56 UTC. |
| **Client address (finding)** | **Confirms run 1** | The sign-in's audit row records `172.68.23.129`, a **Cloudflare** address (172.64.0.0/13). On Render with `TRUST_PROXY=1`, `req.ip` is Cloudflare's edge address, not the visitor's. The client-IP probe must establish which header is the real address and whether it can be forged. |

**Next:** §3 step 4, the application test with the synthetic accounts (needs the staging frontend site); step 5, the client-IP probe (needs the probe service and the Netlify site); step 6, the rollback rehearsal.

### Verification round — 2026-11-18, 16:08–16:16 UTC (owner request: production read-only, application test, client IP; no rollback rehearsal, no migrations)

**1. Production (read-only)**

| Check | Result | Evidence |
|---|---|---|
| Health | PASS | `ok`; database and storage `up` |
| Still on `b7ed2a3` | PASS (consistent) | 9 features = `b7ed2a3`'s "always" set; `/api/v1/forms` 404. The API does not report a commit. |
| Synthetic usernames absent (READ ONLY transaction) | PASS | 0 rows for `staging.drill.admin-d37686` and `staging.drill.student-d37686`; 0 `staging.drill.*` or `@staging.invalid` users. Users 13/6/2/1. 31 migrations, 0 post-Phase-1, 0 failed. **0 audit rows since 15:35 UTC.** |

**2. Application test** (§3 step 4; synthetic accounts only)
- **Netlify staging site: none exists.** Every existing branch deploy and PR preview proxies to **production**. That covers
  `feat-teacher-student-access--`, `test-e2e-playwright--`, `develop--` and `deploy-preview-39/40--roflms.netlify.app`: all
  show 9 features. So unmerged frontend previews talk to the production backend and its real data. **Risk to note.**
- Instead, the integrated release frontend ran locally with `next start` and `API_PROXY_TARGET` set to the staging
  backend. That is the same Next.js `/api` rewrite Netlify runs. It is the local `integ/frontend-rc` at `262e044`, which
  contains PR heads #31–#39; #40 is tests only. Its routes manifest names only `rof-backend-staging.onrender.com`. Nothing
  was deployed.
- Result: **24/24 PASS**:
  - the Administrator signs in through the frontend;
  - 9 Administrator pages load without error: dashboard, users, students, forms, bulk, schools, coaches, teacher
    applications, notification deliveries;
  - the user list has 24 rows and no dates of birth;
  - Forms: 4;
  - bulk preview: read-only, 14 matched, nothing started (0 bulk operations);
  - coach applications list: 200;
  - the synthetic student sees **only** the date-of-birth step; a too-young date is refused in the form; after a valid
    date the student reaches the portal; 4 student pages load;
  - a second change gets **409 `DATE_OF_BIRTH_ALREADY_SET`**;
  - Administrator routes give **403** to the student.
- Phone masking was **not exercised**: no user in the restored data has a phone or guardian phone. The automated tests
  cover it.
- Writes (branch only): 5 `LOGIN`, 1 `DATE_OF_BIRTH_ADDED`, 1 `ADMIN_REQUEST`; 0 e-mail deliveries.

**3. Client address through Cloudflare → Render → backend (`TRUST_PROXY=1`), staging only**

| Test | Result |
|---|---|
| Visitor's public address (this machine) | `196.12.134.189` |
| Address recorded for the Administrator's sign-ins (6 sign-ins, plain and with a forged header) | Always a **Cloudflare** address: `172.68.22.174`, `172.68.22.175` or `172.68.23.129`, **rotating** between requests. Never the visitor's. |
| Forged `X-Forwarded-For: 6.6.6.6` | Not used: a Cloudflare address was recorded. Not forgeable. |
| Forged `CF-Connecting-IP` / `True-Client-IP` | **Rejected by Cloudflare (403)** before reaching the backend. Cloudflare controls this header. |
| Synthetic student: 5 wrong passwords, then the right password ×4 from the same machine | `401 ×5`, then `200 429 429 200`. **No `LOCK_ACCOUNT`**: the 5 failures were spread over rotating Cloudflare addresses. The right password was accepted at once. The last 200 came despite the per-username window, because the **known-address exemption** treated the Cloudflare address `172.68.23.129` as the student's own. |

**Conclusion.** On Render with `TRUST_PROXY=1`, `req.ip` is a Cloudflare edge address shared by many visitors and rotating
between requests. It is not forgeable, but it is not the visitor's address. Consequences for the release:
- **The address-scoped lock does not hold an attacker.** Failures spread across edge addresses, and a lock that does
  trigger falls on everyone behind that edge address. In Rwanda that may be most users.
- **The known-address exemption also covers attackers** routed through the same edge.
- **Per-address limits** (sign-in 60 a minute, the 120 and 3000 ceilings) are shared by everyone behind an edge address.
- **Today's production** has the same issue for its 10-a-minute sign-in limit.

The per-username windows (5 a minute, 20 an hour) still apply, except when the exemption applies. **The sign-in change
should not be released until the backend uses the real visitor address.**

**Proposed fix (needs the probe evidence and owner approval; not implemented).** Read the visitor address from
`CF-Connecting-IP`. On Render every request passes through Cloudflare, and Cloudflare sets the header and rejects forged
values (observed above). Use it only when the deployment says so, e.g. `CLIENT_IP_HEADER=cf-connecting-ip`, and keep
`TRUST_PROXY=1`. Through the Netlify `/api` proxy, `CF-Connecting-IP` would be Netlify's address, so the probe through a
Netlify site must show which header carries the visitor there, such as Netlify's `x-nf-client-connection-ip` or its
`X-Forwarded-For`.

**Needed for the probe (owner; reported before any change):**
1. Render: a new web service `rof-client-ip-probe`:
   - repository `ROFBACKENDTEST`, branch `feat/teacher-student-access`;
   - Node runtime, build `npm ci`, start `node scripts/ops/client-ip-probe.mjs`;
   - no environment variables, auto-deploy off.

   It logs and stores nothing.
2. Netlify: a **new, separate site**, for example `rof-lms-staging`, from the frontend repository, branch `develop` (any
   branch with the `/api` rewrite will do), with `API_PROXY_TARGET` set to the probe URL. Do **not** change the
   production site's branch or preview settings.
3. Send both URLs. The developer then calls the probe directly and through Netlify, with and without forged headers,
   and compares against the visitor's public address.
