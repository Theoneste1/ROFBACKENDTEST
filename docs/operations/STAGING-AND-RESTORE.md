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
| E-mail | dry run: no `RESEND_API_KEY`, so messages are logged and not sent | nobody receives anything |

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
2. **Neon** → the new branch → **Roles → New role** `staging`. Do not reuse the production role.
3. **Render → New → Web Service** `rof-backend-staging`, from repository `ROFBACKENDTEST`, branch
   `feat/teacher-student-access`, with **Auto-Deploy: No**. **Before the first deploy**, enter all its environment
   variables on the creation page:
   - `DATABASE_URL` and `DIRECT_DATABASE_URL`: the **branch's** pooled and direct strings for role `staging`. Check that
     the host starts with the **branch** endpoint id (`ep-…`) and not production's. Production's endpoint id is in your
     production Render service; compare them.
   - `JWT_SECRET`: a new random value of 64 characters or more. Never copy production's.
   - `NODE_ENV=production`, `TRUST_PROXY=1`, `STORAGE_DRIVER=local`, and **no** `RESEND_API_KEY`.
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

Filled in by the drill (date, branch endpoint id, release SHA, each step's result). Until then: **not run**.
