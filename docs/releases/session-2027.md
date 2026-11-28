# Release session-2027 — sessions end after 60 minutes without activity

Migration `20270102000000_session_activity` (one nullable column, `RefreshToken.lastActivityAt`), backend PR #124,
frontend PR #108. Owner decision 2026-11-28. **The order below is mandatory**; each wrong order is an outage.

| Wrong order | What happens |
|---|---|
| Backend code before the migration | Every sign-in and every refresh fails: the code writes and reads `lastActivityAt` (Prisma selects every column). Total sign-in outage until the migration runs. |
| Backend before the frontend | A browser that never reports activity (the old frontend, or a tab still running it) is refused 62 minutes after its session's last recorded activity — active users are signed out mid-work. |
| Migration rollback before the backend rollback | The same outage as the first row. |

## Prerequisites
- **question-marking-2027 is applied** on the target (the kit's precheck refuses otherwise): `prisma migrate deploy`
  applies every pending migration, so releasing session-2027 on a database without the question-marking migrations
  would apply those too. Release question-marking-2027 first (its feature flag can stay OFF).
- A fresh backup of the target database.

## Steps
1. **Precheck (read only):** `node scripts/release/rehearsal.mjs precheck --release session-2027` (section 1 must
   read `2, 0, 0`; section 2 `0`). Keep section 3 for comparison.
2. **Migrate:** `node scripts/release/rehearsal.mjs deploy --release session-2027 --confirm <endpoint>`. Additive and
   instant (a nullable column; no table rewrite, no lock beyond a brief ACCESS EXCLUSIVE for the catalog change). The
   running (old) backend never names the column: it keeps working; new tokens get NULL, which counts as their issue
   time.
3. **Postcheck:** `… postcheck --release session-2027` (section 1 `1, 0, 0`; section 2 `1`; section 3 unchanged).
4. **Frontend #108 live** (Vercel). It reports activity to `POST /auth/activity`; until the backend has it, the report
   answers 404 and the browser simply keeps reporting at most once a minute. The 60-minute sign-out in the browser
   works from this moment.
5. **Backend #124 live** (merge to `main` → Render auto-deploy). From now on the server refuses a refresh more than
   62 minutes after the session's last recorded activity (`401 SESSION_IDLE_EXPIRED`).
6. **Check:** `GET /api/v1` lists `sessionIdleTimeout`; sign in, wait a minute, use a page, then
   `SELECT "lastActivityAt" FROM "RefreshToken" ORDER BY "createdAt" DESC LIMIT 1` moves forward.

## What existing sessions see at step 5
Sessions whose current refresh token was issued more than 62 minutes earlier and that have reported no activity
(browsers closed for over an hour) are asked to sign in again at their next visit — the intended behaviour. Open,
active tabs keep working: their tokens rotate every 15 minutes and their activity is reported.

## Rollback
1. Backend: deploy the previous release first (it never names the column).
2. Then, only if needed: `docs/migrations/20270102000000_session_activity.rollback.sql` (drops the column; it holds
   only activity times), then `npx prisma migrate resolve --rolled-back 20270102000000_session_activity`.
3. The frontend can stay: against the previous backend its activity reports answer 404 and are ignored.
