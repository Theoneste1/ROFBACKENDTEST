# banking-2026 release: the banking information migration after launch-2026

The owner's runbook for releasing the banking information feature (owner 2026-11-25). Every production step needs the
owner's separate approval. Nothing here has been run against production.

It needs the launch-2026 release in production first (its seven migrations). The release record says they were applied
to production on 2026-11-23 (with a backup taken first). That is not proof of today's state: pre-check section 1 must
still show it in the window. This release adds one migration. The kit lists it in `scripts/release/releases.mjs`
(`BANKING_2026_MIGRATIONS`), and its tests check that list against `prisma/migrations`.

What ships: `develop` = production `main` plus the banking work only: backend PR #101 (the feature and this
migration) and PR #102 (Coaches and Head Coaches give personal details only), frontend PR #86. PR #102 adds **no**
migration: it changes only which fields are required, and the school columns of `UserBankDetails` are already
nullable. Production still needs this release's one migration before the new backend runs, because without the
`UserBankDetails` table the new backend fails on every signed-in request. No new environment variable, in either
repository. The feature has no switch: `bankingDetails` is always on in the new backend.

| # | Migration | What it adds | Existing rows |
|---|---|---|---|
| 1 | `20261231000000_user_bank_details` | `UserBankDetails`: one row per Teacher, Coach or Head Coach with their bank details (account name, bank, number): personal and school for Teachers, personal only for Coaches and Head Coaches (the school columns are nullable) | untouched; the table starts empty |

The migration is additive. The previous backend ignores the new table. So the order is: migration first, then the new
backend, then the frontend. The frontend shows the banking step and the administrators' views only when `GET /api/v1`
lists the capability `bankingDetails`.

**The behaviour change comes with the new backend, not with the migration.** From the moment the new backend runs,
every Teacher, Coach and Head Coach is asked for their banking information at their next request, and can do nothing
else until it is complete (they can still sign out, change their password and read their profile). Nobody has bank
details yet, so all of them are asked. Tell them before the release. Students, Administrators and Super Administrators
are not affected.

What "complete" means (final requirements, owner 2026-11-25):
- **Teachers:** all six fields — personal account name, bank (Umwalimu SACCO, fixed), account number (exactly 12
  digits); school account name, bank (Umwalimu SACCO, fixed), account number.
- **Coaches and Head Coaches:** the three personal fields only — account name, bank (from the approved list), account
  number. School bank details are never asked of them and never block them. School details saved earlier are kept
  as they are (never deleted or overwritten) and still shown, masked, to administrators.
- **Teachers:** both account numbers (personal and school, Umwalimu SACCO) are exactly 12 digits. **Everyone:** account
  names contain no digit.
- **Changing details later:** the owner, in their Settings ("Banking information": Edit), at any time; an administrator
  with `users.manage`, on the person's page (`PUT /api/v1/admin/users/:id/banking`, the person's role rules, recorded in
  the audit log as `BANK_DETAILS_UPDATED_BY_ADMIN`: which fields changed, never their values).

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
3. Deploy the backend, then **at once** the frontend. Between the two, the previous frontend has no banking step: a
   Teacher, Coach or Head Coach who is signed in gets "Complete your banking information to continue." on every page
   and cannot fix it there until the new frontend is live. Keep that gap short and choose a quiet time.
4. Check: `GET /api/v1` lists `bankingDetails`; a Teacher test account sees "Complete Your Banking Information" with
   personal and school sections; a Coach test account sees the personal section only; a Student does not see the
   step.

## 3. Staging test before production (optional; see docs/operations/STAGING-AND-RESTORE.md)

The staging setup is a Neon branch of production, the Render service `rof-backend-staging` (auto-deploy off) and a
frontend preview whose `API_PROXY_TARGET` is the staging backend. To test this release there:
1. 🔑 A **new** Neon branch of production (it must hold launch-2026, as production does), and `.env.drill.local`
   pointing at it, with `DRILL_DATABASE_URL` defined **once** (the kit refuses a file that defines it twice).
2. `node scripts/release/rehearsal.mjs precheck --release banking-2026`, then `deploy --release banking-2026 --confirm
   <ep-id>`, then `postcheck` (branch only; the kit refuses production).
3. 🔑 `rof-backend-staging` deployed at the `develop` commit, `DATABASE_URL` set to the branch, and
   `TEACHERS_ENABLED=true` and `HEAD_COACHES_ENABLED=true` (on in production and in the current staging service) so
   that Teacher and Head Coach test accounts can be created; e-mail stays dry run. A frontend preview of `develop`
   pointing at it.
4. Test accounts: `scripts/release/staging-accounts.mjs` creates a synthetic Administrator and Student only. Create one
   Teacher, one Coach and one Head Coach as that Administrator in the staging site (synthetic names, `@staging.invalid`
   addresses); never sign in as a real person. The branch holds a copy of real people's data: keep the URLs private
   and delete the branch and the staging deploy afterwards.

## 4. Rollback

Deploy the previous backend first (the new one reads the table on every Teacher, Coach and Head Coach request). Then
run `docs/migrations/20261231000000_user_bank_details.rollback.sql` (kit: `node scripts/release/rehearsal.mjs rollback
--release banking-2026`). It **refuses** while any bank details exist (`BANK_DETAILS_ROLLBACK_REFUSED`), because they
would be lost. To drop them knowingly, after a backup that contains them: `SET rof.bank_details_rollback =
'discard-bank-details';` (kit: `--acknowledge bank-details`). Then mark the migration rolled back, as a separate
approved step: `npx prisma migrate resolve --rolled-back 20261231000000_user_bank_details`.
