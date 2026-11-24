# email-2026 release: e-mail within the Resend Free plan

The owner's runbook for the release after launch-2026. Every production step needs the owner's separate approval.
Nothing here has been run against production.

Owner decision 2026-11-24: the platform stays on Resend's **Free plan permanently** — at most 100 e-mails a day and
3,000 a month. How the API enforces it: `docs/EMAIL.md` §10.

The release adds one migration (`EMAIL_2026_MIGRATIONS` in `scripts/release/releases.mjs`); it requires every
launch-2026 migration to be applied first.

| # | Migration | What it adds | Existing rows |
|---|---|---|---|
| 1 | `20261231000000_email_free_plan` | `EmailDeliveryStatus` value `DISCARDED`; `EmailPriority` (CRITICAL, NORMAL, BULK); nullable `EmailDelivery.priority`, `kind`, `linkExpiresAt`, `linkTokenId`; table `EmailSendingState` (the shared provider pause); four indexes | untouched (no UPDATE) |

The migration is additive and the previous backend keeps working on it (it never reads the new columns, and no row is
DISCARDED until the new backend runs). Order: migration, then the new backend, then the frontend (the "Sending today"
panel appears when `GET /api/v1` lists `emailBudget`).

## Environment (Render)

Nothing is required: the defaults are the Free plan (100 per UTC day / 3,000 per month, margins 5 / 100 → 95 / 2,900;
NORMAL 80 %, BULK 50 %). If the owner ever moves to Resend Pro: `EMAIL_DAILY_LIMIT=0` (no daily limit) and
`EMAIL_MONTHLY_LIMIT=50000`. Set `EMAIL_DAILY_LIMIT`, `EMAIL_MONTHLY_LIMIT`, `EMAIL_DAILY_SAFETY_MARGIN`, `EMAIL_MONTHLY_SAFETY_MARGIN`,
`EMAIL_NORMAL_SHARE_PERCENT`, `EMAIL_BULK_SHARE_PERCENT` only to change them (`.env.example`). The staging service
(`EMAIL_DRY_RUN=true`) is budgeted the same way.

## What the new backend does with the waiting queue (automatically, within a minute of starting)

Production on 2026-11-24 (read-only): 51 PENDING e-mails. The worker classifies each by its subject and `createdAt`
(no manual SQL), then:

| Waiting e-mails | Kind / priority | What happens |
|---|---|---|
| 43 "Confirm your e-mail address", account already activated | EMAIL_VERIFICATION, CRITICAL | **DISCARDED** ("the account is already activated…"), text erased, never sent |
| 2 "Confirm your e-mail address", account not yet activated | EMAIL_VERIFICATION, CRITICAL | sent first if their 48-hour link (from `createdAt`, or the matched token's expiry) is still valid; DISCARDED ("the activation link expired…") if it ran out before the release. The person can then use "Forgot password", which sends a fresh activation link |
| 1 "Reset your password" (19:39 UTC, to a @resend.dev test address) | PASSWORD_RESET, CRITICAL | **DISCARDED** ("the password-reset link expired before it could be sent…") — older than 30 minutes |
| 2 "Welcome" (one to a @resend.dev test address) | WELCOME, NORMAL | sent, after the CRITICAL ones, within the NORMAL share |
| 1 "Your teacher application" | APPLICATION_DECISION, NORMAL | sent (kept) |
| 2 "You are subscribed to Rwanda Olympiad Foundation news" (@resend.dev test addresses) | SUBSCRIBER_WELCOME, NORMAL | sent (kept) |

Sending respects the budget: e-mails sent since 00:00 UTC that day count (220 were sent in the 24 hours before the
read-only check on 2026-11-24), so if the day's budget is already used they wait until just after 00:00 UTC — PENDING, attempts untouched — and go out by themselves when it frees, most urgent first.

The 7 decision notices `teacher.application.approved` that FAILED with "Resend 429 daily_quota_exceeded" (the bug fixed
in this release) are **not** re-sent automatically. After the release, with the owner's approval, an Administrator uses
Admin → E-mail → "Retry e-mails that failed only because of the daily limit (N)": each is re-queued only if the
applicant's account is still active and the application is still APPROVED (audited `RECOVER_QUOTA_FAILED_EMAILS`). The
two old FAILED e-mails (configuration errors, not 429) are never touched.

## 1. Prerequisites (go / no-go)

1. The backend commit is approved, CI green, kit tests pass: `node --test scripts/release/rehearsal.test.mjs
   scripts/release/staging-accounts.test.mjs` and `test/release-rollback-resume.e2e-spec.ts`.
2. launch-2026 is in production. `scripts/release/email-2026-precheck.sql` (read only): section 1 `7, 0, 0`,
   section 2 `0, 0, 0, 0`. Keep sections 3–6 (they show the queue above and the recoverable rows).
3. Render auto-deploy paused; the previous backend commit noted (rollback target).

## 2. Backup

As in `docs/releases/launch-2026.md` §2 (`pre-email-2026-<date>.dump`).

## 3. Deploy

1. `psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/email-2026-precheck.sql > precheck.txt`
2. `DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy` — exactly `20261231000000_email_free_plan`.
3. `psql … -f scripts/release/email-2026-postcheck.sql > postcheck.txt`: section 1 `1, 0, 0`; section 2 `1, 1, 4, 1`;
   section 3 `EmailDeliveryStatus PENDING,SENT,FAILED,DISCARDED`, `EmailPriority CRITICAL,NORMAL,BULK`; section 4 the
   four columns nullable without default; section 5 `4`; section 6 equal to pre-check section 3; section 7 `0, 0`
   before the new backend starts.
4. `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` → no difference.
5. Deploy the backend, then the frontend. Smoke test: `GET /api/v1` lists `emailBudget`; Admin → E-mail shows
   "Sending today" with the numbers; within a minute the waiting queue matches the table above
   (`GET /api/v1/admin/email/deliveries?status=DISCARDED` shows the reasons).
6. With the owner's approval only: the recovery button (above).

## 4. Rollback

Only with the owner's approval, after a fresh dump.

1. Deploy the previous backend first (it cannot read DISCARDED rows — the rollback file turns them into FAILED).
2. `node scripts/release/rehearsal.mjs rollback --release email-2026 --confirm <ep-id>` (production: the file
   `docs/migrations/20261231000000_email_free_plan.rollback.sql` with `psql`). It refuses while any e-mail is DISCARDED
   or a waiting e-mail carries budget data; after the owner approves, again with `--acknowledge email-budget`
   (`SET rof.email_free_plan_rollback = 'discard-email-budget-data'`).
3. `node scripts/release/rehearsal.mjs rollback-history --release email-2026 --confirm <ep-id>` deletes the history
   row. The enum value DISCARDED stays (unused); re-deploying later works (`ADD VALUE IF NOT EXISTS`).

## 5. Rehearsal

`node scripts/release/rehearsal.mjs <precheck|deploy|postcheck|rollback|rollback-history> --release email-2026` on a
Neon branch of production (guarded; never production). Locally, `test/release-rollback-resume.e2e-spec.ts` deploys,
rolls back (refused, acknowledged, interrupted and resumed) and re-applies the release on real PostgreSQL.
