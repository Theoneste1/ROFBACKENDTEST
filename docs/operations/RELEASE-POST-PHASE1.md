# post-Phase-1 release: the eleven migrations after M14

Production today holds Phase 1 (M1–M14, backend `main` `b7ed2a3`). This release adds the eleven migrations below, in
this order (Prisma applies them in name order; `scripts/release/releases.mjs` lists them, and the tests check the
list against `prisma/migrations`):

| # | Migration | Rollback (`docs/migrations/`) |
|---|---|---|
| 1 | `20261201000000_teacher_applications` | `…teacher_applications.rollback.sql` |
| 2 | `20261202000000_notification_outbox` | `…notification_outbox.rollback.sql` |
| 3 | `20261203000000_student_olympiad_interests` | `…student_olympiad_interests.rollback.sql` |
| 4 | `20261204000000_registration_details` | `…registration_details.rollback.sql` |
| 5 | `20261205000000_avatar_file_purpose` | `…avatar_file_purpose.rollback.sql` (keeps the `AVATAR` enum value) |
| 6 | `20261206000000_account_states` | `…account_states.rollback.sql` |
| 7 | `20261207000000_bulk_operations` | `…bulk_operations.rollback.sql` |
| 8 | `20261207000100_bulk_membership_guard` | `…bulk_membership_guard.rollback.sql` |
| 9 | `20261208000000_form_availability` | `…form_availability.rollback.sql` |
| 10 | `20261209000000_application_details` | `…application_details.rollback.sql` |
| 11 | `20261210000000_teacher_student_access` | `…teacher_student_access.pre-switch.sql` **before the code switch**, then `…teacher_student_access.rollback.sql` (revokes narrowed delegations, never widens) |

Everything that is the same as Phase 1 is in `RELEASE-PHASE1-RUNBOOK.md` and is not repeated here: the release
checkout pinned to the approved SHA (§2.0), the PostgreSQL 18 tools and `pgpass.conf` (§0, §2.2), pausing Render
auto-deploy, and "merging to `main` is the deploy, after `migrate deploy`, never before" (§1, §3). Every production
step needs the owner's separate approval.

Rehearsed 2026-11-18 on a restored copy of the production backup (local, never production): pre-check → deploy all
eleven → post-check → rollback newest first → schema equal to the backup except the `AVATAR` enum value → re-deploy
(`docs/FINAL-REVIEW-PACKAGE.md` §5).

## 1. Rehearsal on a Neon branch of production (never production)
From the release checkout, with `.env.drill.local` pointing at the branch (`REHEARSAL-NEON-CHECKLIST.md`):

```
node scripts/release/rehearsal.mjs check-target          --release post-phase1
node scripts/release/rehearsal.mjs precheck              --release post-phase1
node scripts/release/rehearsal.mjs status                --release post-phase1    # the eleven "not yet applied", exit 1
node scripts/release/rehearsal.mjs deploy                --release post-phase1 --confirm <ep-id>
node scripts/release/rehearsal.mjs diff                  --release post-phase1    # exit 0: no drift
node scripts/release/rehearsal.mjs postcheck             --release post-phase1    # every MUST holds
node scripts/release/rehearsal.mjs rollback              --release post-phase1 --confirm <ep-id>
node scripts/release/rehearsal.mjs rollback-history      --release post-phase1 --confirm <ep-id>   # deletes the eleven rows
node scripts/release/rehearsal.mjs status                --release post-phase1    # the eleven again, exit 1
node scripts/release/rehearsal.mjs deploy                --release post-phase1 --confirm <ep-id>   # re-deploy works
node scripts/release/rehearsal.mjs postcheck             --release post-phase1
```

The kit refuses (exit 5) a checkout without these eleven migrations, a database that records anything after them, or a
database without all of Phase 1. A checkout with later migrations (e.g. `develop` with the design areas) is refused by
`deploy`, `diff` and `status` (they act on every migration of the checkout) and accepted by `check-target`, `precheck`,
`postcheck`, `rollback`, `rollback-history`, `dump` and `restore`, which run only this release's own files and checks.
Deploy from the release checkout (`b5536fd`, or a release branch from it with the kit fix cherry-picked). Without
`--release` it is the Phase 1 kit, unchanged.

**Interrupted rollback (staging, 2026-11-19).** `rollback` can be run again after any stop — a guard refusing, a lost
connection, `--stop-after`. Before running anything it checks every migration against its complete object list
(`MIGRATION_OBJECTS` in `scripts/release/releases.mjs`): a migration of which nothing remains is skipped ("already
rolled back"); one that is only partly there (e.g. its table dropped but a column or trigger left) is refused with the
list of what remains, and none of its files run — restore from the backup or finish it by hand after review. Each file
runs in one transaction, so a refused or failed file changes nothing. Guards are never bypassed:

```
node scripts/release/rehearsal.mjs rollback --release post-phase1 --confirm <ep-id> --acknowledge registration-details
```

`--acknowledge <id>` (repeatable, each once) sets exactly the session setting that file's guard checks, from a fixed
allow-list (`ACKNOWLEDGEMENTS` in `releases.mjs`; the error lists the ids); an unknown, malformed or repeated id is
refused before connecting. `PGOPTIONS="-c rof.registration_details_rollback=discard-registration-details"` still works.
The log prints every acknowledgement in effect. Acknowledge only with approval and after a backup that holds the data.
`--stop-after <n>` stops after n files (to rehearse an interruption).

`dump` / `restore` need `pg_dump` / `pg_restore` at least as new as the server, on `PATH` or in `PG_BIN`
(PowerShell: `$env:PG_BIN = "C:\Program Files\PostgreSQL\18\bin"`; Git Bash:
`export PG_BIN="C:/Program Files/PostgreSQL/18/bin"`). The kit checks the folder, both tools and their versions first.

Backup drill: restore the pre-release dump into an empty branch, then
`node scripts/db-drill-verify.mjs --baseline pre-post-phase1 --trigger-test` (the state just before this release).
`--baseline pre-phase1` remains the state before Phase 1.

## 2. Production window (differences from the Phase 1 runbook)
1. **Before:**
   - production has `WORKERS_ENABLED` not `false` (bulk operations run in the API process);
   - e-mail is configured (bulk messages);
   - `TEACHERS_ENABLED` stays off unless separately approved. Teacher registration stays closed whatever its form says.
2. **Dump** production (Phase 1 runbook §2.1), named `pre-post-phase1-<date>.dump`.
3. **Pre-check (read only):** `psql -X -v ON_ERROR_STOP=1 -f scripts/release/post-phase1-precheck.sql`. Every MUST holds; keep the output.
4. **Migrate:** `npx prisma migrate deploy`. It lists exactly the eleven names.
5. **Post-check (read only):** `psql -X -v ON_ERROR_STOP=1 -f scripts/release/post-phase1-postcheck.sql`. Every MUST holds; the compare lines equal the pre-check.
6. **Deploy frontend and backend together** (merge both `develop` → `main`; Phase 1 runbook §3). Order matters: a student without a date of birth is held by the new backend until they give it, and only the new frontend shows that step (frontend #36 no later than backend #62); Head Coach notification switches (frontend #34) need backend #61. If they cannot go out together, deploy the frontend first: it does nothing new against the old backend except the Head Coach switches, which then show an error card for a few minutes. Then smoke-test:
   - sign-in (a student without a date of birth sees the date-of-birth step, then the portal);
   - student registration (open or closed as before);
   - the admin settings page;
   - `GET /api/v1` capabilities (now also `accountStates`, `bulkUserOperations`, `formAvailability`).

## 3. What the migrations change in existing data
- Accounts with `isActive = false` become `SUSPENDED`; all others `ACTIVE`. `isActive` is kept in sync by a trigger.
- Student registration starts **open** unless `registration.studentSelfSignup` was `false`. Teacher registration starts **closed** unless `registration.teacherSelfSignup` was `true`. Coach applications and the contact form start open.
- New nullable columns stay empty; new tables start empty.

## 4. Rollback
**First, while the NEW release is still serving:** run `docs/migrations/20261210000000_teacher_student_access.pre-switch.sql` (revokes every active ASSIGNED / SELECTED teacher delegation, audited; idempotent). The previous release has no student scope and would apply such a delegation to the teacher's whole school. Then deploy the previous application release, and run the eleven rollbacks newest first, as the kit does:
- **Data guard:** most refuse (`…_ROLLBACK_REFUSED`) while data would be lost. Each file's header gives the explicit, session-level `SET rof.…_rollback = 'discard-…'` that accepts the loss (with the kit: `--acknowledge <id>`, §1). Only set it with approval. After a refusal, run the same `rollback` again: migrations already rolled back are skipped (§1).
- **History:** none edits `_prisma_migrations`. Delete the eleven history rows as their own reviewed step, only after confirming every object is gone. This is what `rollback-history` checks.
- **`AVATAR`:** the enum value stays. The migration adds it with `IF NOT EXISTS`, so a re-deploy works.
