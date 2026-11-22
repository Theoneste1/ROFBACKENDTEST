# dec-2026 and levels-2026 releases: three migrations after late-2026

Production holds Phase 1, post-Phase-1, the design areas and late-2026 (backend `main` `2912405`, ending with
`20261222000000_bulk_operations_generic`). Two release groups follow, **in this order**. Prisma applies migrations in
name order; `scripts/release/releases.mjs` lists each group, and its tests check the lists against `prisma/migrations`.

| # | Group | Migration | Rollback (`docs/migrations/`) |
|---|---|---|---|
| 1 | dec-2026 | `20261223000000_olympiad_interest_other` | `…olympiad_interest_other.rollback.sql` |
| 2 | dec-2026 | `20261223000100_test_resubmission_lock` | `…test_resubmission_lock.rollback.sql` |
| 3 | levels-2026 | `20261224000000_divisions_levels` | `…divisions_levels.rollback.sql` |

The levels-2026 pre-check refuses (section 1 MUST `…, 2, 0, 0`) unless both dec-2026 migrations are applied and nothing
from `20261224000000` exists yet. So the order cannot be reversed by accident.

Everything that is the same as earlier releases is in `RELEASE-PHASE1-RUNBOOK.md` and `RELEASE-POST-PHASE1.md` and is
not repeated here. That covers:
- the release checkout pinned to the approved SHA;
- the PostgreSQL 18 tools;
- pausing Render auto-deploy;
- the dump before the window;
- "merging to `main` is the deploy, after `migrate deploy`, never before".

Every production step needs the owner's separate approval.

## 1. Rehearsal (never production)

Rehearsed locally on 2026-11-22. The starting point was `main`'s 35 migrations, the demo seed, and extras:
- tests for JUNIOR, SENIOR and ALL, each with a submission;
- a student whose division disagrees with the grade (S2 in SENIOR).

The steps were:
1. dec-2026 pre-check, deploy, post-check;
2. levels-2026 pre-check, deploy, post-check;
3. `prisma migrate diff` against the schema: no drift.

A digest of users (id, role, grade, division, status, school), Junior/Senior divisions, tests and their levels,
submissions, coach assignments, enrolments, course resources and assignments was **identical before and after**. The
S2 student stayed in SENIOR.

The rollback was then run **for real** on a copy:
- the new tables were gone;
- the schema equalled the dec-2026 schema;
- the data was identical to the start.

The history row was then removed and the migration re-deployed: identical again.

On a Neon branch, use `node scripts/release/rehearsal.mjs <command> --release dec-2026` and then `--release levels-2026`.
The commands are check-target, precheck, deploy, postcheck, rollback and rollback-history.

## 2. Production window

1. **Dump** production, named `pre-dec-levels-2026-<date>.dump`.
2. **dec-2026, from the checkout pinned to the approved `develop` SHA that contains it:**
   1. `psql -X -v ON_ERROR_STOP=1 -f scripts/release/dec-2026-precheck.sql`: every MUST holds; keep the output.
   2. `npx prisma migrate deploy`: exactly the two dec-2026 names.
   3. `psql -X -v ON_ERROR_STOP=1 -f scripts/release/dec-2026-postcheck.sql`: every MUST holds; compare lines equal the pre-check.
3. **levels-2026, from the checkout pinned to the approved `develop` SHA that contains `20261224000000_divisions_levels`:**
   1. `psql -X -v ON_ERROR_STOP=1 -f scripts/release/levels-2026-precheck.sql`: every MUST holds; keep the output.
   2. `npx prisma migrate deploy`: exactly `20261224000000_divisions_levels`.
   3. `psql -X -v ON_ERROR_STOP=1 -f scripts/release/levels-2026-postcheck.sql`. Every MUST holds:
      - JUNIOR S1–S3 (order 1), MIDDLE with no grade (order 2), SENIOR S4–S6 (order 3);
      - the student counts and tests by level equal the pre-check;
      - every submission has its level;
      - every course is offered in every division.
4. **Deploy the backend, then the frontend** (merge each `develop` into `main`, backend first).
   - The frontend shows each new screen only when `GET /api/v1` lists its capability: `olympiadLevels`, `adminDivisions`, `studentOverview`, `customReports`, `tableLayouts`.
   - The new frontend against the old backend therefore behaves as before.
   - The new backend against the old frontend keeps every existing response.
5. **Smoke test:**
   - `GET /api/v1/divisions` lists Junior, Middle and Senior;
   - an Administrator opens Divisions, a student's user page (Olympiad level card) and Reports → Custom reports;
   - a student signs in and sees their tests.

## 3. What the migrations change in existing data

- **dec-2026:**
  - adds nullable columns;
  - adds the resubmission-authorization table;
  - existing rows are untouched.
- **levels-2026:**
  - The conversions are value-preserving:
    - `Division.code` and `Test.division` become text holding the same values;
    - MIDDLE is added with no grade and no students;
    - JUNIOR is suggested for S1–S3 and SENIOR for S4–S6.
  - Every student keeps their current division (no re-placement). `divisionManual` is false for everyone.
  - Every submission gets its level from the student's division (`TestSubmission.level`).
  - Every course is offered in every division (as before).
  - New, empty: `DivisionChange`, `TableLayout`, `CustomReport`, `CustomReportGrant`.

## 4. Rollback

Deploy the previous application release first, then run the rollbacks newest first: levels-2026, then dec-2026.

- `…divisions_levels.rollback.sql` **refuses**:
  - while a test, student, enrolment, coach assignment, resource, assignment, discussion or override uses a division
    other than JUNIOR or SENIOR (move them first);
  - while a level was set by hand, unless `SET rof.divisions_levels_rollback = 'discard-classifications'`;
  - while a saved custom report or table layout exists, unless
    `SET rof.divisions_levels_rollback_reports = 'discard-reports-and-layouts'`.

  Only set those with approval, after a dump that contains the data.
- Courses a division stopped offering become visible to its students again.
- None of the rollbacks edits `_prisma_migrations`. Delete the history row as its own reviewed step, after confirming
  `DivisionChange` is gone.
- Tested by `test/divisions-levels-rollback.e2e-spec.ts`: the file runs to the end with only Junior and Senior in use
  and keeps every student's division, every test level, every coach assignment and every enrolment. It refuses in
  each case above.
