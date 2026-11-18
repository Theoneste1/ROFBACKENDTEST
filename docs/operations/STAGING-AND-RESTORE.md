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
2. **Neon** → the new branch → **Roles → New role** `staging`. Do not reuse the production role. Then, in the Neon
   **SQL Editor with this branch selected**, run `GRANT neondb_owner TO staging;`.
   - Tables and types belong to `neondb_owner`, and a new role may neither create in `public` nor alter them, so the
     migrations fail without this grant (run 2).
   - On `main` the statement fails with "role staging does not exist", because the role exists only on the branch.
     That makes it a built-in safety stop.
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
   `C:\rof-audit\be-ts\.env.drill.local`, which is git-ignored, containing one line:
   `DRILL_DATABASE_URL=<the branch's direct connection string for role staging>`.
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
- **Next owner action:** §2 step 6, `C:of-audite-ts.env.drill.local`. Done for run 2.

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
