# question-marking-2027 release: question-level marking

The owner's runbook for releasing question-level marking (design Rev 5.2, implementation approved 2026-11-26). Every
production step needs the owner's separate approval. Nothing here has been run against production.

It needs banking-2026 in production first (pre-check section 1 must show it in the window). The kit lists this release's
migrations in `scripts/release/releases.mjs` (`QUESTION_MARKING_2027_MIGRATIONS`); its tests check that list, the object
lists and the rollback files against the SQL.

| # | Migration | What it adds | Existing rows |
|---|---|---|---|
| 1 | `20270101000000_question_marking_kind` | the `TestMarkingKind` value `COMPOSED` only (a new enum value cannot be used in the transaction that adds it) | untouched |
| 2 | `20270101000100_question_marking` | `Test.markingMode` (default `PAPER`), `TestQuestion.promptVersion` (default 1), eleven tables, eight enums, the guards (triggers), two commit-time invariants, four functions; the `TestMarking_assignment_matches_kind` CHECK re-created to accept `COMPOSED` | every test stays `PAPER`; nothing is converted |

**Switch:** `QUESTION_MARKING_ENABLED` (backend), default off. Off: the question routes answer 404 `FEATURE_DISABLED`,
the capability `questionMarking` is not listed, the frontend shows nothing new; PAPER marking is unchanged either way.
Order: migrations → backend (switch off) → frontend → owner's approval → switch on (staging pilot first).

## 1. Go / no-go

1. Backend and frontend commits approved; CI green; kit tests pass (`node --test scripts/release/rehearsal.test.mjs`).
2. `scripts/release/question-marking-2027-precheck.sql` on production (read only): section 1 `1, 0, 0`; section 2
   `0, 0`. Keep sections 3–5 to compare.
3. A backup from the window (Neon branch, or `rehearsal.mjs dump --release question-marking-2027`).

## 2. The window

1. `npx prisma migrate deploy` (production direct URL) — both migrations.
2. `scripts/release/question-marking-2027-postcheck.sql`: section 1 `2, 0, 0`; section 2 `11, 0, 1, 0, 0`; section 3 equal
   to the pre-check's sections 3–4; section 4 `19` and `4`; section 5 `0`.
3. Deploy the backend with `QUESTION_MARKING_ENABLED` unset (off), then the frontend. Smoke: PAPER marking as before.
4. Switch on only with the owner's approval, after the staging pilot.

## 3. Rollback, by level

1. **Switch off** (`QUESTION_MARKING_ENABLED=false`, restart): routes and screens disappear, data stays, PAPER unaffected.
2. **Previous code** (schema kept): only while `rehearsal.mjs code-rollback-check --release question-marking-2027`
   (`question-marking-2027-code-rollback-check.sql`) shows `0, 0` — no QUESTION-mode test has tasks and no COMPOSED marking.
3. **Schema rollback** (`docs/migrations/2027010100*.rollback.sql`, newest first, through the kit):
   - It **always refuses while a COMPOSED final marking exists** (approved question-marked papers: their results live in
     the shared results tables) — roll forward instead.
   - Otherwise, when any question-marking data exists, it needs **evidence, not acknowledgement**:
     1. `rehearsal.mjs dump --release question-marking-2027 --out <EFS folder> --confirm <ep>`;
     2. `rehearsal.mjs verify-backup --release question-marking-2027 --dump <file> --confirm <ep>` — restores the dump into
        the EMPTY scratch database `DRILL_SCRATCH_DATABASE_URL`, compares per-table counts and md5 checksums with the live
        database, writes `<dump>.manifest.json` (dump sha256, checks, time, operator) and CSV copies of every question
        table and the COMPOSED markings and scores, only when equal;
     3. `rehearsal.mjs rollback --release question-marking-2027 --evidence <manifest> --confirm <ep>` — the dump's sha256 is
        checked again; the rollback file recomputes the checksums in its own transaction and refuses on any difference
        (data written after the backup: take and verify a new backup).
   - Then `rollback-history --release question-marking-2027` (both history rows), as its own approved step.
   - `COMPOSED` stays in the enum (PostgreSQL cannot drop a value); the original CHECK is restored.
