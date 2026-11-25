# banking-2026 release: the banking information migration after launch-2026

The owner's runbook for releasing the banking information feature (owner 2026-11-25). Every production step needs the
owner's separate approval. Nothing here has been run against production.

It needs the launch-2026 release in production first (its seven migrations). This release adds one migration. The kit
lists it in `scripts/release/releases.mjs` (`BANKING_2026_MIGRATIONS`), and its tests check that list against
`prisma/migrations`.

| # | Migration | What it adds | Existing rows |
|---|---|---|---|
| 1 | `20261231000000_user_bank_details` | `UserBankDetails`: one row per Teacher, Coach or Head Coach with their personal and school bank details (account name, bank, number) | untouched; the table starts empty |

The migration is additive. The previous backend ignores the new table. So the order is: migration first, then the new
backend, then the frontend. The frontend shows the banking step and the administrators' views only when `GET /api/v1`
lists the capability `bankingDetails`.

**The behaviour change comes with the new backend, not with the migration.** From the moment the new backend runs,
every Teacher, Coach and Head Coach is asked for their banking information at their next request, and can do nothing
else until it is complete (they can still sign out, change their password and read their profile). Nobody has bank
details yet, so all of them are asked. Tell them before the release. Students, Administrators and Super Administrators
are not affected.

## 1. Prerequisites (go / no-go before the window)

Go only if every line holds:
1. The backend commit is approved and its CI is green. Its kit tests pass:
   `node --test scripts/release/rehearsal.test.mjs scripts/release/staging-accounts.test.mjs`.
2. `scripts/release/banking-2026-precheck.sql` on production (read only) shows every MUST line holding:
   section 1 `7, 0, 0`, section 2 `0`. Keep section 3 (users by role) to compare.
3. A backup (Neon branch or `node scripts/release/rehearsal.mjs dump --release banking-2026`) exists from the window.

## 2. The window

1. `npx prisma migrate deploy` against production's direct URL (or `node scripts/release/rehearsal.mjs deploy --release
   banking-2026` on a rehearsal branch first).
2. `scripts/release/banking-2026-postcheck.sql`: section 1 `1, 0, 0`; section 2 `1, 0`; section 3 equal to the
   pre-check's.
3. Deploy the backend, then the frontend. Check: `GET /api/v1` lists `bankingDetails`; a Teacher test account sees
   "Complete Your Banking Information"; a Student does not.

## 3. Rollback

Deploy the previous backend first (the new one reads the table on every Teacher, Coach and Head Coach request). Then
run `docs/migrations/20261231000000_user_bank_details.rollback.sql` (kit: `node scripts/release/rehearsal.mjs rollback
--release banking-2026`). It **refuses** while any bank details exist (`BANK_DETAILS_ROLLBACK_REFUSED`), because they
would be lost. To drop them knowingly, after a backup that contains them: `SET rof.bank_details_rollback =
'discard-bank-details';` (kit: `--acknowledge bank-details`). Then mark the migration rolled back, as a separate
approved step: `npx prisma migrate resolve --rolled-back 20261231000000_user_bank_details`.
