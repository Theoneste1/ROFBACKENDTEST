# Phase 1 migration rollbacks

Every Phase 1 migration (M1–M10, `prisma/migrations/2026112100…`) has a rollback file here.
Each is run **manually, with owner approval, after a backup**, against the database the
release was deployed to — never automatically.

## Order

Roll back in **reverse order of application**, newest first, and deploy the previous
application release before rolling back a migration the running code depends on.

| Step | Rollback | Why it must come before the next |
|---|---|---|
| 1 | M10 `20261121000900_school_affiliation_integrity` | its triggers read `StudentSchoolAffiliation`; after M9's table is dropped, every change to `User.schoolId` would fail |
| 2 | M9 `20261121000800_student_school_affiliation` | its claims reference schools (`ON DELETE RESTRICT`); M8's rollback deletes official schools and is refused (23503) while a claim, current or superseded, references one |
| 3 | M8 `20261121000700_official_school_list` | it uses M7's `code` column |
| 4 | M7 `20261121000600_school_codes` | — |
| 5 | M6 `20261121000500_teacher_school_assignment` | — |
| 6 | M5 `20261121000400_permission_overrides` | — |
| 7 | M4 `20261121000300_last_super_admin_guard` | — |
| 8 | M3 `20261121000200_backfill_programme_membership` | it removes rows from M2's table |
| 9 | M2 `20261121000100_programme_membership` | — |
| 10 | M1 `20261121000000_roles_teacher_head_coach_super_admin` | it refuses while any row uses the Phase 1 roles |

A partial rollback (for example only M10, or M10 and M9) follows the same order from the top.

## Prisma migration history (`_prisma_migrations`)

The files do **not** all handle the history the same way:

- **M1–M8** delete their own `_prisma_migrations` row inside the rollback transaction, so the
  schema change and the history change commit together.
- **M9 and M10** deliberately **do not** edit the history. The rollback removes the objects
  only; the history row is removed afterwards as a separate, reviewed and approved step, once
  the rollback has committed and been verified. Each file lists that procedure (verify the
  objects are gone → back up → delete the row → `npx prisma migrate status`).

So after rolling back M10 and M9, `prisma migrate status` still lists them as applied until
their history rows are removed. Do not run `prisma migrate deploy` in between: it would treat
them as applied and skip them.

## Academic-year rollover and M10

A rollover copies each student's previous-year enrolment school to `User.schoolId`. That
normally equals `User.schoolId` already. If it does not, the school would change without a
new claim, and M10 refuses the rollover statement (and so the whole rollover transaction) (`AFFILIATION_SCHOOL_MISMATCH`).
Nothing is changed. M10's pre-check reports how many current-year enrolments differ from
`User.schoolId`. That count must be 0 on the production rehearsal.
