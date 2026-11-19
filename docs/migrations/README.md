# Phase 1 migration rollbacks

Every Phase 1 migration (M1–M14, `prisma/migrations/2026112100…`) has a rollback file here.
Each is run **manually, with owner approval, after a backup**, against the database the
release was deployed to — never automatically.

## Order

Roll back in **reverse order of application**, newest first, and deploy the previous
application release before rolling back a migration the running code depends on.

| Step | Rollback | Why it must come before the next |
|---|---|---|
| 1 | M14 `20261121001300_school_directory_sync_approval` | deploy the previous release first (the code reads the approval columns). **Refused** while approval or recompare history exists unless its loss is explicitly acknowledged after a backup; restores M13's run guard; never touches the directory |
| 2 | M13 `20261121001200_school_directory_sync` | deploy the previous release first (the code reads the sync tables). **Refused** while any sync run exists unless losing the sync history is explicitly acknowledged after a backup; it never touches schools, contacts or source records and does not undo applied syncs |
| 3 | M12 `20261121001100_school_directory_model` | deploy the previous release first (the code reads the directory tables and allows repeated names). **Refused** while two schools share a name (the unique index cannot return; never delete or rename schools to force it) and, unless explicitly acknowledged after a backup, while directory data exists (see the file) |
| 4 | M11 `20261121001000_school_administration` | deploy the previous release first (the code reads the new School columns); nothing else depends on its columns |
| 5 | M10 `20261121000900_school_affiliation_integrity` | its triggers read `StudentSchoolAffiliation`; after M9's table is dropped, every change to `User.schoolId` would fail |
| 6 | M9 `20261121000800_student_school_affiliation` | its claims reference schools (`ON DELETE RESTRICT`); M8's rollback deletes official schools and is refused (23503) while a claim, current or superseded, references one |
| 7 | M8 `20261121000700_official_school_list` | it uses M7's `code` column |
| 8 | M7 `20261121000600_school_codes` | — |
| 9 | M6 `20261121000500_teacher_school_assignment` | — |
| 10 | M5 `20261121000400_permission_overrides` | — |
| 11 | M4 `20261121000300_last_super_admin_guard` | — |
| 12 | M3 `20261121000200_backfill_programme_membership` | it removes rows from M2's table |
| 13 | M2 `20261121000100_programme_membership` | — |
| 14 | M1 `20261121000000_roles_teacher_head_coach_super_admin` | it refuses while any row uses the Phase 1 roles |

A partial rollback (for example only M14, or M14 and M13) follows the same order from the top.

## Prisma migration history (`_prisma_migrations`)

The files do **not** all handle the history the same way:

- **M1–M8** delete their own `_prisma_migrations` row inside the rollback transaction, so the
  schema change and the history change commit together.
- **M9 to M14** deliberately **do not** edit the history. The rollback removes the objects
  only; the history row is removed afterwards as a separate, reviewed and approved step, once
  the rollback has committed and been verified. Each file lists that procedure (verify the
  objects are gone → back up → delete the row → `npx prisma migrate status`).

So after rolling back any of M9 to M14, `prisma migrate status` still lists them as applied until
their history rows are removed. Do not run `prisma migrate deploy` in between: it would treat
them as applied and skip them.

## Audit rows written by the migrations

M3, M8, M9 and M11 each write one system audit row (`PROGRAMME_MEMBERSHIP_BACKFILL`,
`OFFICIAL_SCHOOL_LIST_LOADED`, `SCHOOL_AFFILIATION_BACKFILL`, `SCHOOL_SOURCE_BACKFILL`; no actor).
The rollbacks **keep** them — audit history is never deleted — so after a full rollback every table
matches the pre-release database except `AuditLog`, which has these extra rows (verified on the local
rehearsal, docs/operations/REHEARSAL-LOCAL-2026-11-13.md).

## Academic-year rollover and M10

A rollover copies each student's previous-year enrolment school to `User.schoolId`. That
normally equals `User.schoolId` already. If it does not, the school would change without a
new claim, and M10 refuses the rollover statement (and so the whole rollover transaction) (`AFFILIATION_SCHOOL_MISMATCH`).
Nothing is changed. M10's pre-check reports how many current-year enrolments differ from
`User.schoolId`. That count must be 0 on the production rehearsal.

## After Phase 1

| Migration | Rollback | Notes |
|---|---|---|
| `20261201000000_teacher_applications` (Teacher self-registration) | `20261201000000_teacher_applications.rollback.sql` | roll it back **before** any Phase 1 migration; deploy the previous release first. **Refused** while any Teacher application exists or any account has a phone or country, unless the loss is explicitly acknowledged after a backup. Like M9–M14 it does not edit `_prisma_migrations` (see the file). Not part of the Phase 1 release kit (`scripts/release/`), which handles M1–M14 only |
| `20261202000000_notification_outbox` (decision notifications) | `20261202000000_notification_outbox.rollback.sql` | roll it back **before** `20261201000000_teacher_applications`; deploy the previous release first. **Refused** while any notification outbox row exists or any Teacher application has a verified school, unless the loss is explicitly acknowledged after a backup. Does not edit `_prisma_migrations` (see the file). Not part of the Phase 1 release kit |
| `20261203000000_student_olympiad_interests` (Olympiad interests of students, owner decision 8) | `20261203000000_student_olympiad_interests.rollback.sql` | roll it back **before** `20261202000000_notification_outbox` and `20261201000000_teacher_applications` (it uses that migration's `OlympiadSubject` enum, which is kept); deploy the previous release first. **Refused** while any account has an Olympiad interest, unless the loss is explicitly acknowledged after a backup. Does not edit `_prisma_migrations` (see the file). Not part of the Phase 1 release kit |
| `20261204000000_registration_details` (student registration details, coach application details) | `20261204000000_registration_details.rollback.sql` | roll it back **before** `20261203000000_student_olympiad_interests` and `20261201000000_teacher_applications` (it uses that migration's `OlympiadSubject` enum, which is kept); deploy the previous release first. **Refused** while any account or coach application holds these details, unless the loss is explicitly acknowledged after a backup. Does not edit `_prisma_migrations` (see the file). Not part of the Phase 1 release kit |
| `20261205000000_avatar_file_purpose` (profile pictures) | `20261205000000_avatar_file_purpose.rollback.sql` | roll it back **before** the earlier post-Phase-1 migrations; deploy the previous release first. **Refused** while any account has a profile picture, unless the loss is explicitly acknowledged after a backup (the acknowledged run also clears the picture links). The `AVATAR` file purpose is kept (PostgreSQL cannot drop an enum value). Does not edit `_prisma_migrations` (see the file). Not part of the Phase 1 release kit |
| `20261206000000_account_states` (account states: ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED; status history) | `20261206000000_account_states.rollback.sql` | roll it back **before** `20261205000000_avatar_file_purpose`; deploy the previous release first. **Refused** while any status-history row or any deactivated or archived account exists, unless the loss is explicitly acknowledged after a backup. `isActive` is kept, so no blocked account regains access. |
| `20261207000000_bulk_operations` (bulk user operations: operations and per-account items; User.createdAt and gradeLevel indexes) | `20261207000000_bulk_operations.rollback.sql` | roll it back **before** `20261206000000_account_states`; deploy the previous release first. **Refused** while any bulk operation is recorded, unless the loss is explicitly acknowledged after a backup. Account changes made by bulk operations are not undone. |
| `20261207000100_bulk_membership_guard` (bulk operations: a trigger on User that takes a shared advisory lock on membership writes) | `20261207000100_bulk_membership_guard.rollback.sql` | roll it back **before** `20261207000000_bulk_operations`, together with the release that creates bulk operations. Drops the trigger and function only; no data changes. |
| `20261208000000_form_availability` (form availability: open, close, schedule, closed messages) | `20261208000000_form_availability.rollback.sql` | roll it back **before** the earlier post-Phase-1 migrations; deploy the previous release first. It writes `registration.studentSelfSignup` / `registration.teacherSelfSignup` back from the forms' current state, then drops the table and its enums. **Refused** while a form has a schedule, custom texts, or the coach / contact form is closed, unless the loss is explicitly acknowledged (`SET rof.form_availability_rollback = 'discard-form-settings'`). |
| `20261210000000_teacher_student_access` (teacher–student assignments, delegation student scope, review flags) | `20261210000000_teacher_student_access.pre-switch.sql`, then `20261210000000_teacher_student_access.rollback.sql` | roll it back **first** (newest). **Different order:** run the pre-switch file while the NEW release still serves (it revokes every active ASSIGNED / SELECTED delegation, audited — the previous release would apply them school-wide), then deploy the previous release, then the rollback (table-locked). **Refused** while any assignment, selected-student row or narrowed delegation exists, unless the loss is explicitly acknowledged (`SET rof.teacher_student_rollback = 'discard-teacher-student-access'`); it never widens a delegation. |
| `20261209000000_application_details` (teacher position / experience, coach phone / affiliation / expertise / experience / rejection reason, requests for more information) | `20261209000000_application_details.rollback.sql` | roll it back **second** (after `20261210000000_teacher_student_access`); deploy the previous release first. Drops ApplicationInfoRequest and the new columns. **Refused** while any information request or application detail exists, unless the loss is explicitly acknowledged (`SET rof.application_details_rollback = 'discard-application-details'`). |
| `20261211000000_countries_reference` (countries, owner decision 2026-11-19: Country table with every ISO 3166-1 alpha-2 code; School.countryCode foreign key) | `20261211000000_countries_reference.rollback.sql` | design-areas release (`--release areas-2026`); roll it back **first** (newest); deploy the previous release first. Drops the foreign key and the table; School.countryCode is kept. **Refused** while an Administrator has corrected a country's name or calling code, unless explicitly acknowledged (`SET rof.countries_reference_rollback = 'discard-country-edits'`). |

### `20261209000000_application_details`: changed before its first production run (checksum note)
On 2026-11-18 (final review), before any production or Neon run and before it reached `develop`, it gained one more step: the full unique indexes on `MentorRequest.username` / `email` are replaced by partial ones (`WHERE status <> 'REJECTED'`), so every coach application attempt is its own row (an earlier attempt's questions and answers never appear as another applicant's). Test and CI databases that applied the earlier version keep the full indexes until recreated; `prisma migrate dev` would report the file as modified (as for the avatar migration below). Production and Neon never applied it.

### `20261205000000_avatar_file_purpose`: changed before its first production run (checksum note)
On 2026-11-17, before any production or Neon run, its enum step became `ALTER TYPE "FilePurpose" ADD VALUE IF NOT EXISTS 'AVATAR';`. Its rollback cannot drop an enum value (PostgreSQL), so without `IF NOT EXISTS` a re-deploy after a rollback failed with `enum label "AVATAR" already exists`. A first run behaves exactly as before.

Prisma stores a checksum of each applied migration file. On a **development or test database that already applied the previous version**:
- `prisma migrate deploy` (CI, Render, production) and `prisma migrate status` don't flag the changed file. This was verified on 2026-11-17 on a throwaway database that had applied the previous version: deploy applied nothing and exited 0; status reported "Database schema is up to date!".
- `prisma migrate dev` compares checksums. Per Prisma's documentation, it reports the migration as modified after it was applied and offers to reset that database. Not run here.

Nothing repairs or resets a database automatically. Resetting a disposable development database (`prisma migrate reset`) is its owner's choice; production and Neon have never applied this migration, so they are unaffected.

The post-Phase-1 release kit: `scripts/release/rehearsal.mjs --release post-phase1` and `docs/operations/RELEASE-POST-PHASE1.md`.
