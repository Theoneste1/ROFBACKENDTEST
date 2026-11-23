# launch-2026 release: the seven migrations after levels-2026

The owner's runbook for the next production release of the backend database. Every production step needs the owner's
separate approval. Nothing here has been run against production.

Production holds every migration up to and including `20261224000000_divisions_levels` (read-only check on
2026-11-23). This release adds seven migrations, in this order (Prisma applies them in name order). The kit lists them
in `scripts/release/releases.mjs` (`LAUNCH_2026_MIGRATIONS`), and its tests check that list against `prisma/migrations`.

| # | Migration | What it adds | Existing rows |
|---|---|---|---|
| 1 | `20261225000000_school_sync_mode` | `SchoolSyncMode` (FULL, NEW_ONLY); `SchoolSyncRun.mode` NOT NULL default FULL | every run reads FULL |
| 2 | `20261225000100_teacher_unlisted_school` | five nullable `TeacherApplication.proposedSchool*` columns (code, cell, village, ownership, day/boarding) | untouched |
| 3 | `20261226000000_registration_data` | `MentorRequest.userId` (unique, FK to User) and `RegistrationSavedFilter` | approved coach applications get their account linked (from the approval's audit entry, or one matching e-mail) |
| 4 | `20261227000000_coach_programme_access` | `CoachCapability`, `CoachProgrammeRestriction` | each REVOKED marking authorisation (not granted again) of a coach still in that programme becomes an active MARKING restriction |
| 5 | `20261228000000_form_email_verification` | `FormAvailability.requireEmailVerification` NOT NULL default false | activation is OFF on every sign-up form |
| 6 | `20261229000000_subscribers` | four enums, `Subscriber`, `Mailing`, nullable `EmailDelivery.subscriberId` | untouched |
| 7 | `20261230000000_view_as` | `ViewAsSession`: an administrator's read-only viewing session of a lower-ranked user (actor, target, reason, single-use ticket hash and expiry, start, expiry, end) | untouched |

All seven are additive. The previous backend keeps working on the new schema (new columns are nullable or have a
default; new tables are unused by it). So the order is: migrations first, then the new backend, then the frontend.
The frontend shows the new screens only when `GET /api/v1` lists their capability (`coachProgrammeAccess`,
`formEmailVerification`, `registrationData`, `subscribers`, `teacherUnlistedSchoolDetails`, `viewAs`).

Two behaviour changes arrive with the new backend, not with the migrations. The owner should know them:
- **Coaches** see the students, courses, marking and results of their programmes at every level. An Administrator
  can remove that per coach and programme. Coaches whose marking was revoked keep that decision: it is carried over.
- **Activation**: every sign-up form starts with activation **off**, whatever `registration.requireEmailVerification`
  said before. The pre-check shows that setting. If it is `true`, switch activation back on for the forms that need
  it right after the release.

## 1. Prerequisites (go / no-go before the window)

Go only if every line holds:
1. The backend commit to release is approved and its CI is green. It contains exactly these seven migrations after
   levels-2026. Its kit tests pass:
   `node --test scripts/release/rehearsal.test.mjs scripts/release/staging-accounts.test.mjs` and
   `test/release-rollback-resume.e2e-spec.ts`.
2. `scripts/release/launch-2026-precheck.sql` on production (read only) shows every MUST line holding:
   section 1 `14, 11, 7, 3, 2, 1, 0, 0`, section 2 `0, 0, 0`.
3. PostgreSQL **18** client tools (production is PostgreSQL 18) are on the operator's machine. If they are not on
   PATH, set `PG_BIN`:
   - PowerShell: `$env:PG_BIN = "C:\Program Files\PostgreSQL\18\bin"`
   - Git Bash: `export PG_BIN="C:/Program Files/PostgreSQL/18/bin"`

   Check with `"$PG_BIN/pg_dump" --version`, which must print 18.x.
4. Render auto-deploy is paused, so merging cannot deploy before the migrations have run.
5. The previous backend commit (production `main` today) is noted. It is the rollback target for the application.
6. A rehearsal passed (section 5): on a Neon branch of production with
   `node scripts/release/rehearsal.mjs <command> --release launch-2026`, or at least the local one below.

No-go if the pre-check's section 1 shows anything from `20261225000000` on, or any failed or rolled-back migration.

## 2. Backup (before anything is written)

Dump production into an EFS-encrypted folder outside the repository and OneDrive (`cipher /e <folder>`). The kit's
`dump` command never targets production (it refuses the production host). Run `pg_dump` directly, with the direct
(non-pooled) endpoint:

```
"$PG_BIN/pg_dump" --format=custom --no-owner --no-acl \
  --file="<EFS folder>/pre-launch-2026-<date>.dump" \
  "host=<direct host> dbname=neondb user=<user> sslmode=require"
```

Give the password through `PGPASSWORD` or a pgpass file, never on the command line. Then check the dump opens:
`"$PG_BIN/pg_restore" --list "<EFS folder>/pre-launch-2026-<date>.dump" | grep -c "TABLE DATA"`. The count must be at
least the number of tables (93 at levels-2026).

## 3. Deploy (production window)

From the checkout pinned to the approved SHA, with `DIRECT_DATABASE_URL` set to production's direct endpoint:

1. `psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/launch-2026-precheck.sql > precheck.txt`
   - Every MUST line holds. Keep the file.
   - Note section 3 (the old activation setting).
   - Section 5 predicts the backfills: the approved coach applications, and the revocations to carry over.
2. `DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy`
   - Expected: exactly the seven names above under "The following migration(s) have been applied", then "All migrations
     have been successfully applied."
   - The rehearsal took 7 s.
3. `psql "$DIRECT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f scripts/release/launch-2026-postcheck.sql > postcheck.txt`.
   Every MUST holds:
   - section 1 `7, 0, 0`;
   - section 2 `5, 6, 9`;
   - section 3 lists the six enum value lists exactly as its heading says;
   - section 4: `SchoolSyncRun.mode` NOT NULL default `'FULL'`, `FormAvailability.requireEmailVerification` NOT NULL
     default `false`, the other seven nullable with no default;
   - section 5 `18, 1, 12, 1`;
   - section 6 all `0`;
   - section 7 equals pre-check section 4;
   - section 8: `linked_not_approved` 0, and `carried_over_restrictions` equal to the pre-check's
     `revocations_to_carry_over`, all of them active MARKING.
4. `DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`.
   Expected: "No difference detected." (exit 0).
5. Deploy the backend (merge to `main`, resume Render), then the frontend.
6. Smoke test:
   - `GET /api/v1` lists the five capabilities above.
   - An Administrator opens Forms (activation switch per form, all off), Subscribers (empty) and the coach access page
     of a coach.
   - A Super Administrator opens Registration data.
   - A teacher application with "My school is not listed" shows the school's details.

If step 2 fails, stop and do not deploy the backend. `_prisma_migrations` shows the failed migration. Decide with
the dump at hand: restore it, or fix forward after review (`prisma migrate resolve`).

## 4. Rollback

Roll back only with the owner's approval, after a fresh dump that contains whatever the new release recorded.

1. **Deploy the previous backend first**, then the previous frontend. The new backend needs the new tables and
   columns.
2. Run the rollback, newest first, against the database (on a Neon branch through the kit; for production, the same
   files in this order with `psql -X -v ON_ERROR_STOP=1 -f`, the acknowledgements set with `SET` in the same session):
   - `node scripts/release/rehearsal.mjs rollback --release launch-2026 --confirm <ep-id>`
   - Every guard refuses while its data exists. Nothing of that file is applied. Run the same command again with the
     acknowledgements the owner approved. It skips what is already rolled back and continues.
   - Order: `20261230000000_view_as`, `20261229000000_subscribers`, `…228…form_email_verification`, `…227…coach_programme_access`,
     `…226…registration_data`, `…225000100…teacher_unlisted_school`, `…225000000…school_sync_mode`.
3. `node scripts/release/rehearsal.mjs rollback-history --release launch-2026 --confirm <ep-id>`. It deletes the seven
   history rows only once every object is gone. For production, delete them as a separate, reviewed step:
   `DELETE FROM "_prisma_migrations" WHERE migration_name IN (…the seven…)`.
4. Check the database is back at levels-2026:
   - `status --release launch-2026` lists the seven as not yet applied (exit 1);
   - `launch-2026-precheck.sql` section 1 is `14, 11, 7, 3, 2, 1, 0, 0` and section 2 `0, 0, 0`;
   - `levels-2026-postcheck.sql` sections 1 to 3 hold. Sections 5 and 7 count work done since levels-2026 (division
     history, saved reports), so they need not be 0 any more.

### What each acknowledgement discards

| `--acknowledge` | Session setting (for `psql`) | Refuses while | Lost if acknowledged |
|---|---|---|---|
| `view-as-sessions` | `SET rof.view_as_rollback = 'discard-sessions'` | any viewing session record exists | the record of who viewed the platform as whom, why and when. The audit log keeps VIEW_AS_STARTED / VIEW_AS_ENDED either way. |
| `subscribers` | `SET rof.subscribers_rollback = 'discard-subscribers'` | any subscriber or mailing exists | the mailing list (names, e-mails, interests, unsubscriptions) and the mailing history. Export first: `GET /api/v1/admin/subscribers/export`. The e-mails stay in EmailJob / EmailDelivery, without the subscriber link. |
| (none: always refuses) | — | a subscriber e-mail is still PENDING | nothing. Let the outbox finish, or cancel the mailing, then run again. |
| `form-email-verification` | `SET rof.form_email_verification_rollback = 'discard-verification-switches'` | any form has activation ON | the per-form switches. The previous backend reads `registration.requireEmailVerification` again (its stored value, unchanged since the release). Note which forms had activation on first. |
| `coach-restrictions` | `SET rof.coach_programme_access_rollback = 'discard-restrictions'` | a restriction other than a carried-over one exists | the record of which coaches had part of their programme access removed, and its history. Carried-over rows go without a guard: the marker authorisations still record those revocations. |
| `saved-filters` | `SET rof.registration_data_rollback = 'discard-saved-filters'` | any saved filter exists | Super Administrators' saved registration filters. The coach application → account link goes without a guard: re-running the migration rebuilds it. |
| `unlisted-school-details` | `SET rof.teacher_unlisted_school_rollback = 'discard-details'` | a PENDING application proposes a school code | the code, cell, village, ownership and day/boarding given for an unlisted school. The name and place stay. The details of already decided applications go without a guard. |
| `sync-modes` | `SET rof.school_sync_mode_rollback = 'forget-modes'` | a NEW_ONLY sync run exists | the mode: such a run then reads as FULL, so its staged comparison no longer matches a recompare. Schools are never touched. |

An acknowledgement never skips a guard. It sets exactly the value that guard reads, on the rollback connection.

## 5. Rehearsal (local, 2026-11-23; never production)

The rehearsal used a local PostgreSQL 18 server and synthetic data. Every command ran from the release checkout
(`chore/release-launch-2026`), through the kit. The kit's guards were satisfied as follows:
- `.env.production.local` named a fake production host;
- `.env.drill.local` named the scratch database `rk_launch_reh` on `localhost`;
- `--confirm localhost` was given.

**Database shaped like production.** A checkout copy without the launch migrations ran `prisma migrate deploy`
up to `20261223000100` (54 migrations). JUNIOR and SENIOR were then inserted, as production had them, and
`20261224000000_divisions_levels` was deployed (55 history rows). The seed (`docs/releases/launch-2026-rehearsal-seed.sql`, synthetic)
then added:
- 6 students in S1–S6;
- 2 coaches, a head coach, a teacher, an administrator and a super administrator;
- Mathematics memberships, with one revoked marking authorisation and one active one;
- three coach applications: approved with the approval's audit entry, approved without it, and pending;
- a pending teacher application with an unlisted school's name;
- a FULL sync run;
- a sent e-mail;
- `registration.requireEmailVerification = false`.

That gives 93 tables, 2,272 rows and 1,974 schools.

The rehearsal was run twice on 2026-11-23: first with the six migrations, then again with all seven once `view_as`
was added. This table records the second run.

| Step | Command | Result |
|---|---|---|
| 1 | `check-target --release launch-2026` | guard passed, no connection (exit 0) |
| 2 | `precheck --release launch-2026` | §1 `14, 11, 7, 3, 2, 1, 0, 0`; §2 `0, 0, 0`; §3 `false`; §4 12 users (1 ADMIN, 1 HEAD_COACH, 2 MENTOR, 6 STUDENT, 1 SUPER_ADMIN, 1 TEACHER), 1,974 schools, 1 run, 1 + 3 applications, 4 forms, 1 job, 1 delivery, 2 authorisations; §5 `2` approved, `1` to carry over (exit 0) |
| 3 | backup (first run) | `pg_dump` 18.7 `--format=custom` → 0.5 MB; `pg_restore --list` lists 94 TABLE DATA entries. The kit's `dump` was refused as designed: first the folder was not EFS-encrypted, then the local server has no SSL, which the kit requires. |
| 4 | `deploy --release launch-2026 --confirm localhost` | exactly the seven applied, "All migrations have been successfully applied." (6.7 s, exit 0) |
| 5 | `postcheck --release launch-2026` | §1 `7, 0, 0`; §2 `5, 6, 9`; §3 the six enums as listed; §4 as listed; §5 `18, 1, 12, 1`; §6 all 0; §7 equal to the pre-check; §8 2 linked (the audit-entry one and the e-mail one), 0 not approved, 0 other roles, 1 carried-over active MARKING restriction (exit 0) |
| 6 | `diff --release launch-2026` | "No difference detected." (exit 0) |
| — | data digest | every row of every table that existed before the deploy is identical (the new columns left out); new: 1 CoachProgrammeRestriction row (the carried-over one) |
| 7 | launch-time data added (`docs/releases/launch-2026-rehearsal-use.sql`) | a NEW_ONLY run, a pending application with a proposed code, a saved filter, an Administrator's coach restriction, activation on for one form, 2 subscribers, a sent mailing with 2 deliveries, a viewing session |
| 8 | `rollback --release launch-2026 --confirm localhost` | `VIEW_AS_ROLLBACK_REFUSED: 1 viewing session record(s) would be lost; nothing was changed` (exit 1) |
| 9 | `rollback … --acknowledge view-as-sessions --acknowledge subscribers` | view_as and subscribers ran; `FORM_EMAIL_VERIFICATION_ROLLBACK_REFUSED: 1 form(s) have activation turned on …` (exit 1) |
| 10 | `rollback … --acknowledge form-email-verification --acknowledge coach-restrictions --acknowledge saved-filters --acknowledge unlisted-school-details --acknowledge sync-modes` | the two rolled-back files skipped ("already rolled back"), the other five ran: "rollback: 5 file(s) run, 2 skipped" (exit 0) |
| 11 | `rollback-history --release launch-2026 --confirm localhost` | "deleted 7 history row(s)" (exit 0) |
| 12 | `status --release launch-2026` | the seven "not yet applied" (exit 1) |
| 13 | `postcheck --release levels-2026` (newer checkout accepted) | §1 `1, 0, 0`; §2 JUNIOR S1–S3 / MIDDLE / SENIOR S4–S6, 3 + 0 + 3 students; §3 `5, 1, 0, 4, 3, 2`; §6 0; §7 `0, 0` (exit 0). §5 shows 6 division changes: those of the seeded students, recorded after levels-2026, as on production. |
| 14 | `precheck --release launch-2026` | §1 `14, 11, 7, 3, 2, 1, 0, 0`, §2 `0, 0, 0` again |
| — | data digest | 0 rows that existed before the release missing or changed; 55 history rows as before. Kept, as the rollback files say: the launch-time sync run (now without its mode), the pending application (name and place), the news EmailJob and its 2 deliveries (without the subscriber link). |
| 15 | `deploy` again, then `postcheck`, then `diff` | seven applied (7.6 s); every MUST holds; "No difference detected." |

The kit's database tests (`test/release-rollback-resume.e2e-spec.ts`) run the same rollback for every release, from
Phase 1 to launch-2026:
- interrupted after every file and resumed;
- refused by each guard in turn;
- half rolled back;
- out of order.

They also prove that the object lists equal what each migration changes in the catalogue, and that the
acknowledgement list equals the guards written in the rollback files.

## 6. Not verified here

- No Neon branch of production was used. The rehearsal ran locally on synthetic data, about 2,300 rows; production
  has more rows. All seven migrations are additive, and the two backfills (registration data, coach access) are
  set-based single statements.
- The application (old and new backend) was not run against the rehearsal database.
- Timing on production. The rehearsal took 8 s locally.

## 7. Adding the next migration

A migration after `20261230000000_view_as` is not part of launch-2026. Either:
- append it to `LAUNCH_2026_MIGRATIONS` before this release ships; or
- define the next release the same way.

Either way, add:
- its `MIGRATION_OBJECTS` entry and its `ACKNOWLEDGEMENTS` (`scripts/release/releases.mjs`);
- its objects to the release's object list, and the pre- and post-check lines;
- a seed for each of its guards in `test/release-rollback-resume.e2e-spec.ts`.

The tests fail until each of these is in place.
