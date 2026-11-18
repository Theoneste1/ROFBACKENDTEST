# Staging environment and Neon restore drill (2026-11-18)

Written for: the owner (account actions) and whoever runs the drill.

**Release gate:** a successful Neon restore and an application test on the restored data are **mandatory before the
production release** (owner decision 2026-11-18). Nothing here uses production credentials or writes to production.
Steps marked 🔑 need the owner's Neon / Render / Netlify accounts; everything else can be done by the developer.

## 1. What staging is

| Part | Staging | Isolation |
|---|---|---|
| Database | a **Neon branch** of the production project (copy-on-write; its own connection string and role) | writes to the branch never touch production |
| Backend | a second Render web service from the release branch, `NODE_ENV=production`, flags as production | own URL; own `JWT_SECRET` (new random), own `DATABASE_URL` = the branch |
| Frontend | a Netlify branch deploy (or a second site) with `API_PROXY_TARGET` = the staging backend | own URL |
| File storage | `STORAGE_DRIVER=local` (temporary disk) or a separate test bucket | never the production bucket |
| E-mail | dry run: no `RESEND_API_KEY` (messages are logged, not sent) | no real person receives anything |

Personal data: the branch holds copies of real accounts (minors). Restrict the staging URLs to the team, do not invite
users, and delete the branch and services after the drill.

## 2. Owner actions 🔑 (about 15 minutes)

1. Neon console → production project → **Branches → Create branch** from `main`, *at a point in time* (e.g. 10 minutes
   ago — this also exercises Neon's point-in-time restore). Name it `restore-drill-<date>`. Do not choose "reset" or
   "restore" on `main`.
2. In the branch, **Roles → create** a new role `staging` (not the production role); copy its pooled and direct
   connection strings into a password manager — send them to the developer through a secure channel (not chat or
   e-mail), or run step 3 yourself.
3. Render → **New web service** `rof-backend-staging` from `develop` (or the release SHA): environment
   `DATABASE_URL` / `DIRECT_DATABASE_URL` = the branch strings, `JWT_SECRET` = a new random 64-character value,
   `NODE_ENV=production`, `STORAGE_DRIVER=local`, no `RESEND_API_KEY`, `TEACHERS_ENABLED` / `HEAD_COACHES_ENABLED` as
   production, `APP_URL` = the staging frontend URL. **Auto-deploy off.**
4. Netlify → the site → **Branch deploys** (or a new site) with `API_PROXY_TARGET` = the staging backend URL.
5. Send the developer the two staging URLs and the Neon branch endpoint id (`ep-…`) — not the password.

## 3. Restore drill and rehearsal (developer; on the branch only)

Use the release kit; it refuses any endpoint other than the one confirmed (`--confirm <ep-id>`).

1. `node scripts/release/rehearsal.mjs status --release post-phase1 --confirm <ep-id>` — the eleven not yet applied.
2. Restore check: the branch's row counts equal production's read-only counts recorded at release time (users by role,
   schools, applications); `scripts/release/post-phase1-precheck.sql` every MUST holds.
3. `node scripts/release/rehearsal.mjs deploy --release post-phase1 --confirm <ep-id>` → `post-phase1-postcheck.sql`
   every MUST → `migrate diff` exit 0.
4. Point the staging backend at the branch (already), deploy the release SHA, deploy the staging frontend.
5. **Application test on the restored data** (record results): Administrator sign-in; user list (masked phones, no
   dates of birth); a student who has no date of birth gets the date-of-birth step; Forms page; a bulk preview; the
   School Access page; a teacher's My Students (verified claims only); the coach applications page; the client-IP probe
   (CLIENT-IP-VERIFICATION.md) if not done.
6. Rollback rehearsal: `…teacher_student_access.pre-switch.sql`, then `rehearsal.mjs rollback` (all eleven,
   newest-first), `rollback-history`, `status` (the eleven again), then `deploy` again.
7. Sign-off record: date, branch id, backup hash, each step's result. Attach to the release record.

## 4. Afterwards 🔑

Delete the Render staging service, the Netlify branch deploy and the Neon branch (Neon → Branches → delete). Rotate
nothing in production (production credentials were never used).

## 5. If the restore or the application test fails

Stop the release. Record what failed; fix on the release branch; repeat §3 on a new branch.
