# Release session-2027: sessions end after 60 minutes without activity (and everything merged with it)

The owner's runbook for releasing backend `develop` and frontend `develop` to production (revised 2026-11-28 after
the integration of backend #121–#128 and frontend #104–#111). **Every production step needs the owner's separate
approval. Nothing here has been run against production.** **The order below is mandatory**; each wrong order is an
outage (section 6).

## 1. What ships

| | Production today | Release |
|---|---|---|
| Backend (Render `rof-lms-api`, auto-deploys `main`) | `main` c55b3e9 | `develop` e115d27, or newer if approved |
| Frontend (Vercel, production = `main`) | `main` e07c0b2 | `develop` 47ed3ac, or newer if approved |

- **Backend:**
  - #123 question-marking concurrency fixes;
  - #121 student lists carry the picture;
  - #122 pictures follow profile access;
  - #124 60-minute inactivity limit on the server;
  - #125 Super Administrators undiscoverable;
  - #126 the refresh returns the profile;
  - #127 cross-feature tests;
  - #128 `render.yaml` says `plan: starter` (no effect on the running service, already Starter).
- **Frontend:**
  - #104 Olympiad level read only for Coaches;
  - #105 pictures and Username column;
  - #106 the Teacher's Tests tab;
  - #107 the user guide inside the system;
  - #108 inactivity warning and sign-out, logo signs out;
  - #109 Super Admin privacy;
  - #110 faster page loads;
  - #111 cross-feature tests.
- **Database: one migration**, `20270102000000_session_activity`:
  - `ALTER TABLE "RefreshToken" ADD COLUMN "lastActivityAt" TIMESTAMP(3)`;
  - nullable, no default, no table rewrite, no change to any existing row;
  - the question-marking-2027 migrations are already in production `main` (released 2026-11-27).
- **No new environment variable**, backend or frontend.
  - `QUESTION_MARKING_ENABLED` stays unset on Render: question-level marking stays off.

## 2. Go / no-go (before the window)
1. Backend `develop` CI and frontend `develop` CI are green on the release commits.
2. **Identify the live database first.** `.env.production.local` has been stale before, and the live site has
   written to a database the team thought was staging. Compare `GET /api/v1/public/statistics` on the live site
   with the same counts in the candidate database. Use the database that matches.
3. Never use `scripts/release/rehearsal.mjs` for production.
   - It is built for Neon rehearsal branches and refuses production by design.
   - Its target is `DRILL_DATABASE_URL` in `.env.drill.local`. Check that this file does **not** point at the live
     database before any rehearsal.
   - Production steps use `psql` and `npx prisma migrate deploy` with the live **direct** (non-pooled) URL.
4. **Rehearsal: done locally on 2026-11-28** (production `main`'s schema and seed data, plus sessions in every state).
   - The precheck reads `2, 0, 0` / `0`; deploy; the postcheck reads `1, 0, 0` / `1`, with section 3 unchanged.
   - Existing sessions are byte-identical, and the schema equals `develop`'s.
   - Production's backend code works on the migrated database (sign-in and refresh 200; activity reports 404).
   - Rollback (section 5) brings back `main`'s schema with the sessions unchanged, and re-migrating works.
   - A Neon-branch rehearsal is optional: the change is one nullable column.

## 3. The window (in this order)
1. **Precheck (read only):**
   `psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/session-2027-precheck.sql`
   - Section 1 MUST read `2, 0, 0`; section 2 MUST read `0`. Keep section 3.
   - Any other value: stop.
2. **Backup:** a Neon branch of the live database, or a `pg_dump`, taken now.
3. **Migrate**, from a clean checkout of the release commit (no `.env*.local` in it):
   `DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy`
   - It must say ``Applying migration `20270102000000_session_activity` `` and nothing else.
   - If it lists any other migration: stop. Production is not in the state this runbook assumes.
   - The running backend (old code) never names the column and keeps working; new sessions get NULL.
4. **Postcheck:** `psql … -f scripts/release/session-2027-postcheck.sql`
   - Section 1 MUST read `1, 0, 0`; section 2 MUST read `1`; section 3 equal to the precheck's.
5. **Frontend live:** merge frontend `develop` into `main` through a PR; Vercel deploys it. Then check:
   - sign-in per role;
   - the user guide from the profile menu;
   - the ROF logo signs out;
   - the browser's activity reports to `POST /auth/activity` answer 404 and are ignored. Expected until step 7.
6. **Wait a few hours**, ideally overnight, before step 7.
   - A tab still running the *old* frontend never reports activity, so after step 7 it is signed out once.
   - That happens up to 62 minutes after its session's last recorded activity.
   - The wait lets open tabs load the new frontend.
7. **Backend live:** merge backend `develop` into `main` through a PR; Render auto-deploys on the Starter instance.
8. **Check:**
   - `GET /api/v1` lists `sessionIdleTimeout` and does **not** list `questionMarking`.
   - Sign in, wait a minute, use a page: the newest `RefreshToken`'s `lastActivityAt` moves forward. Read only:
     `SELECT "lastActivityAt" FROM "RefreshToken" ORDER BY "createdAt" DESC LIMIT 1`.
   - An Administrator test account cannot find a Super Administrator by username, and sees no Super Admins tab.
   - The Teacher's and Coach's student lists show pictures or initials and a Username column.
9. **What users notice:**
   - The warning at 55 minutes and the sign-out at 60.
   - The logo signs out.
   - Sessions whose current token is over 62 minutes old with no recorded activity (browsers closed for over an
     hour) must sign in again. Intended.

## 4. Rollback order (the reverse; owner's approval for each step)
1. **Backend first:** in Render, redeploy the previous deploy, or revert the `main` merge. The previous backend
   never names the column.
2. **Frontend** may stay: against the previous backend its activity reports answer 404 and are ignored. To roll it
   back anyway: revert its `main` merge, or promote the previous Vercel deployment.
3. **Database only if needed, and only after step 1:** section 5. Never while #124's code is running, or every
   sign-in and refresh fails.

## 5. Rolling back the migration
1. Take a backup. The column holds only activity times; nothing else is lost.
2. `psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f docs/migrations/20270102000000_session_activity.rollback.sql`
3. Confirm the column is gone (expect `0`):
   `SELECT count(*) FROM information_schema.columns WHERE table_name = 'RefreshToken' AND column_name = 'lastActivityAt';`
4. Then remove the migration's history row. This step is guarded: it deletes nothing while the column exists.

       DELETE FROM "_prisma_migrations"
        WHERE migration_name = '20270102000000_session_activity'
          AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'RefreshToken' AND column_name = 'lastActivityAt');

   - **Do not use `npx prisma migrate resolve --rolled-back`.** It only works on a *failed* migration; this one
     succeeded, so Prisma refuses with P3012 (shown in the rehearsal).
   - Leaving the row means the history says "applied" while the column is gone. A later `migrate deploy` would then
     skip the migration, and the next release of #124 would fail every sign-in.
5. Re-release later from section 3. The rehearsal showed `migrate deploy` applying the migration again cleanly.

## 6. Why the order is mandatory

| Wrong order | What happens |
|---|---|
| Backend before the migration | Every sign-in and every refresh fails: the code writes and reads `lastActivityAt`. Total sign-in outage until the migration runs. |
| Backend before the frontend | Browsers that never report activity (the old frontend) are refused 62 minutes after their session's last recorded activity: active users are signed out mid-work. |
| Migration rollback before the backend rollback | The same outage as the first row. |
| Rollback without removing the history row (section 5.4) | The next release skips the migration: the same outage as the first row. |

Render never runs migrations: its Docker image only starts the server (see `render.yaml`). Migrations are applied
from a developer machine before `main` moves, which is why the migration in backend `develop` is applied before the
backend that contains it goes live.
