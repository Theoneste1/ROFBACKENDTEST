# Local migration rehearsal (M1–M14), 2026-11-13

**This is not the production rehearsal.** It used a local, disposable PostgreSQL 17 (production is
PostgreSQL 18 on Neon) and **synthetic** data. The production-copy rehearsal on a Neon branch
(docs/operations/RELEASE-PHASE1-RUNBOOK.md §0) is still required before the owner approves the release.

## Data

Created by the code that runs in production (`origin/main` a8df186) through its own API on a database
migrated with main's 17 migrations and main's seed: an administrator, four coaches, ten students
(registrations that created schools from free text, invitations, a CSV import), ten legacy schools,
enrolments in the current year, a planned next year. One legacy school's name matched an official
school except for letter case (to exercise M8's adoption).

## Results

| Step | Result |
|---|---|
| `scripts/release/phase1-precheck.sql` (read only) | every MUST held: 1 discipline (MATHEMATICS), 0 diverged enrolments, roles STUDENT/MENTOR/ADMIN only, no failed migration |
| `prisma migrate deploy` (14 migrations) | applied in 8 s |
| M8 | 1,973 official schools inserted; the case-differing legacy school **adopted** (same id and name, code 350201, `OFFICIAL_LIST`); 10 legacy schools uncoded |
| M9 | 10/10 students with a school have one current PENDING claim for it |
| M3 | 14 memberships (students and coaches → Mathematics) |
| M12 | `School_name_key` dropped; `School_code_key` present; user counts unchanged |
| Old `main` API on the migrated schema | admin moving a student to another school → **500** `23514 AFFILIATION_SCHOOL_MISMATCH` (M10); self-registration → 201 but the student has a school and **no claim** → the freeze in the runbook is required |
| New API (`fix/release-readiness`) on the migrated data | existing accounts log in; ADMIN `/me/permissions` has `schools.manage`; directory 1,974 official + 10 legacy; 10 PENDING claims; registration with an official code; an admin school change (claim follows); **academic-year rollover on the migrated data succeeds** (no M10 refusal) and a repeat is replayed; courses and assignments load |
| School leaderboard after migration | empty in both divisions (0 VERIFIED claims) until administrators verify claims |
| Rollback M14 → M1 (docs/migrations, M9–M14 history rows removed as a separate step) | all 14 succeeded, none needed an acknowledgement (no directory or sync data) |
| After rollback | `prisma migrate diff` against main's schema: **no difference**; main's `migrate status`: up to date; 45 of 46 tables identical row-for-row to the pre-migration copy; `AuditLog` keeps the 4 migration audit rows |
