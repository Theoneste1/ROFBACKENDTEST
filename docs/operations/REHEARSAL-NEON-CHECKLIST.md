# Phase 1 rehearsal on a Neon branch + backup/restore drill (Part B) — checklist

Executable version of RELEASE-PHASE1-RUNBOOK.md §0.2. **Nothing here touches production**: every
tool refuses the production database (the backup drill dumps the rehearsal branch; production's own
dump is the separate, owner-approved step of the release window, runbook §2.2). Every step needs the
owner's approval (docs/AI_COLLABORATION_PROTOCOL.md). Connection strings are never pasted into chat,
issues, commits, logs **or a command line** (shell history and the process list keep them); they live
only in git-ignored `.env.*.local` files.

**One checkout, one working directory.** Run every command below from the root of a clean checkout of
the **release SHA** the owner approved (`APPROVED_RELEASE_SHA`, RELEASE-PHASE1-RUNBOOK.md §0.2: the backend
`develop` head once every change for this release is merged — on 2026-11-14 `fe919356b05dfea3f96898d1961b1709583bdb48`,
with further fixes pending) — the runner refuses
any other working directory. The rehearsal must use the same SHA as the production release; a later
merge into `develop` means a new rehearsal. Before step R0, from that checkout (PowerShell):

```powershell
git rev-parse HEAD                     # MUST print APPROVED_RELEASE_SHA
git status --porcelain                 # MUST print nothing
git merge-base --is-ancestor 52537ad15d6507000ab94d9832e23e8266127670 HEAD; $LASTEXITCODE   # MUST print 0
```

The last check proves the checkout contains the PR #38 guard (commit `52537ad`, "kit refuses migrations
after M14"). The verifier line below does **not** prove it: `rev 2` is printed by checkouts from before
PR #38 too (for example `293e08d`), so do not rely on it for this.

The verifier and the runner read migrations, schema and SQL from the checkout they belong to; no other branch or checkout (in particular not `main`) is used for any step. Each tool
prints its verifier line first; it must read exactly
`verifier: db-drill-verify rev 2 (hardened target guard)` (the runner: `verifier guard: …`). Any other
line, or none: **stop** — an older copy is running.

| Tool | Does | Writes? |
|---|---|---|
| `node scripts/release/rehearsal.mjs <cmd>` | guarded runner (below) | `deploy`, `rollback`, `rollback-history`, `restore` write to the target; `dump` writes a file; each needs `--confirm <ep-id>` |
| `scripts/release/phase1-precheck.sql` | pre-flight MUSTs (M3/M10 aborts, roles, history) | no (READ ONLY transaction) |
| `scripts/release/phase1-postcheck.sql` | post-migration MUSTs | no (READ ONLY transaction) |
| `node scripts/db-drill-verify.mjs [--baseline pre-phase1]` | integrity + id fingerprints of a copy; default = migrated to this checkout, `--baseline pre-phase1` = before M1–M14 (production `main` today: 17 migrations, 46 tables), derived from this checkout | no (one rolled-back trigger test) |

**Phase 1 only (exit 5):** the runner refuses every command when the checkout contains a migration after
M14 (`20261121001300_…`), and every command that connects when the target database already records one —
`deploy` would otherwise apply it too and `rollback` would leave it behind. Run the kit from the
checkout of `APPROVED_RELEASE_SHA` (above): it contains the guard and its last migration is M14. A
checkout without the guard (for example `293e08d`, from before PR #38) would **not** refuse later
migrations — the `merge-base --is-ancestor` check above rules it out. Exit 5: **stop**, do not work
around it (never edit or delete a migration folder to get past it).

The runner reads `DRILL_DATABASE_URL` from `.env.drill.local` and uses the fail-closed guard of
`db-drill-verify.mjs`: it refuses to run unless `.env.production.local` names the production host and
the target differs from it — by host and by endpoint id; pooled/direct, letter case, percent-encoding
and a trailing dot do not matter — and from every database in `.env`, `.env.local` and the
environment. A target URL with `host`, `hostaddr`, `port`, `service` or `options` query parameters is
refused (they could redirect the connection): use the string exactly as the Neon console shows it. It
always connects to the branch's **direct** endpoint, and Prisma gets that URL with every `DOTENV_*`
switch removed (so `.env` can never replace it). No `psql` is needed for the rehearsal. Prisma prints
the branch host (never a password). Verified end to end on a local PostgreSQL 17 copy of the `main`
schema (2026-11-13): refusals, pre-check, deploy (5.5 s), post-check, diff, rollback M14→M1,
history clean-up, then `main` schema identical and 46/47 tables identical (AuditLog +4 rows, by design).

## 0. Prerequisites (owner)

| Need | Why | Status |
|---|---|---|
| Neon console access to project (production branch `production`) | create branches, read endpoint ids | owner has it |
| **2 free branch slots** (Free plan: 10/project) | `rehearsal-…` and `rollback-…` (B2 restores into a new database on one of them) | check Branches page |
| `.env.production.local` with production `DATABASE_URL` (exists since the P0-04 drill) | guard identifies production to refuse it | exists — verify, don't print |
| `.env.drill.local` with `DRILL_DATABASE_URL=` (rewritten per branch) | the only target the tools accept | owner writes it |
| Node 24 + backend `develop` checkout with `npm ci` and `npm run build` | runner, Prisma 7.10 CLI, API | ready |
| **PostgreSQL 18 client tools** (`pg_dump`, `pg_restore` 18.x; on `PATH` or `PG_BIN`) | Part B only: the runner refuses a `pg_dump` older than the server (18.6) | **missing on this machine** — install needs approval (EDB "Command Line Tools" or `choco install postgresql18`) |
| An **EFS-encrypted folder outside the repository and outside OneDrive** (e.g. `mkdir C:\rof-backups; cipher /e C:\rof-backups`) | the dump holds personal data; the runner writes dumps only into such a folder (it checks all three) | owner creates it |
| Throwaway `JWT_SECRET` (≥ 32 chars) for the local API | API start | generate locally |
| An administrator login the owner may use on the copy | §R5 checks | owner types it; never shared |

**Database versions.** Production: PostgreSQL **18.6** (Neon). Tested so far: CI 16, local rehearsal
17.5. Prisma is 7.10 on both `main` and `develop`. The migrations use only core features (plpgsql,
`gen_random_uuid()`, jsonb, triggers, `ALTER TYPE … ADD VALUE`) and no extension. **This rehearsal is
the first run on 18** — its main purpose besides real data.

## R. Rehearsal

**R0 — Create the branch (owner, Neon console).** Branches → New branch → parent `production` →
**Current data** (head) → name `rehearsal-phase1-<yyyymmdd>` → auto-delete in 1–2 days → Create.
Note the **creation time** (UTC) and the **endpoint id** (`ep-…`). Copy the **direct** connection
string (pooling off) into `.env.drill.local` as `DRILL_DATABASE_URL=…`.

**R1 — Guard.** `node scripts/release/rehearsal.mjs check-target` → `✔ guard passed`. Anything else: stop.

**R2 — Pre-check.** `node scripts/release/rehearsal.mjs precheck > rehearsal-precheck.txt`
(file outside the repo or deleted afterwards; it holds counts only). Every MUST:

| § | MUST | If not |
|---|---|---|
| 1 | `failed_or_running = 0`, `rolled_back = 0`, `phase1_already_applied = 0`, latest row `20261120000000_email_html_body` | stop: history is not the `main` baseline |
| 2 | `disciplines = 1` and `mathematics = 1` (when `students_and_coaches > 0`) | stop: **M3 aborts** |
| 5 | `diverged = 0` | stop: M10 applies, but every later rollover would be refused for those students; fix enrolments first (owner decision) |
| 6 | roles only `ADMIN`, `MENTOR`, `STUDENT` | stop: unexpected data |
| 7 | exactly one current year | stop: review academic years |

Record the information lines (§3 schools, §4 students with/without school, §8 sizes).

**Part B before R3:** do B1 and B2 (fingerprints and dump of the rehearsal branch) **now** — R3 changes
the branch. (B3–B5 can wait for the rollback branch.)

**R3 — Migrate.** `node scripts/release/rehearsal.mjs status` → "31 migrations found in
prisma/migrations", "Following migrations have not yet been applied:" and the 14 names `20261121000000_…`
to `20261121001300_…`; exit code **1** is expected here (Prisma's code for pending migrations). Then `node scripts/release/rehearsal.mjs deploy --confirm <ep-id>` → "All migrations have been
successfully applied." Record `elapsed`. **Never run `db seed`.**

Abort conditions inside the migrations (each rolls back its own migration; the earlier ones stay applied):

| Migration | Aborts when |
|---|---|
| M3 | not exactly one discipline `MATHEMATICS` while students/coaches exist |
| M10 | a student has several current claims, or a current claim's school differs from `User.schoolId` (cannot happen right after M9 unless data was written concurrently) |
| any | connection lost / timeout → `status` shows the failed migration |

On failure: copy the error, run `status`, **stop**. Do not retry or `migrate resolve` without analysis.

**R4 — Post-check.** `node scripts/release/rehearsal.mjs diff` → "No difference detected." (exit 0), then
`node scripts/release/rehearsal.mjs postcheck > rehearsal-postcheck.txt`:

| § | Expected |
|---|---|
| 1 | `phase1_applied = 14`, `failed_or_rolled_back = 0`, `total_rows = 31` |
| 2 | four audit rows: `PROGRAMME_MEMBERSHIP_BACKFILL` (student + coach memberships = pre-check `students_and_coaches`), `OFFICIAL_SCHOOL_LIST_LOADED` (`adopted + inserted = 1974`), `SCHOOL_AFFILIATION_BACKFILL` (`withSchool` = pre-check `students_with_school`; `nameOnly` ≤ `name_only_claims_from_register_audit` — M9 reads only each student's latest REGISTER entry), `SCHOOL_SOURCE_BACKFILL` (`officialList = 1974`) |
| 3 | users per role identical to pre-check §6 |
| 4 | one row `BACKFILL / true` = `students_and_coaches` |
| 5 | `OFFICIAL_LIST 1974/1974 coded`; `LEGACY` = pre-check schools − adopted, 0 coded |
| 6 | only `School_code_key` |
| 7 | all claims `PENDING / MIGRATION`; **no VERIFIED**; `students_with_school_but_no_claim = 0` |
| 8 | `0 / 0` |
| 9 | 11 triggers, all `O`: `audit_log_append_only`, `audit_log_fill_actor`, `school_contact_keep`, `school_external_id_keep`, `school_source_record_immutable`, `school_sync_change_keep`, `school_sync_item_keep`, `school_sync_run_guard`, `school_affiliation_integrity`, `user_last_super_admin_guard`, `user_school_affiliation_integrity` |
| 10 | `0 / 0 / 0` |

Then `node scripts/db-drill-verify.mjs --trigger-test --json <file outside the repo>` on the migrated
branch (first line: the rev 2 verifier line): all checks pass (31/31 migrations, every model has its
table, 0 orphaned rows).

**Schema changes to expect** (all additive except M12): new enum values `TEACHER`, `HEAD_COACH`,
`SUPER_ADMIN` (M1); tables `ProgrammeMembership` (M2, filled by M3), `UserPermissionOverride` (M5),
`TeacherSchoolAssignment` (M6), `StudentSchoolAffiliation` (M9), directory tables `EducationLevel`,
`Programme`, `SchoolContact`, `SchoolDataSource`, `SchoolEducationLevel`, `SchoolExternalId`,
`SchoolProgramme`, `SchoolSourceRecord` (M12), sync tables `SchoolSyncRun`, `SchoolSyncItem`,
`SchoolSyncChange` (M13, columns M14); new `School` columns — `code`, `nameKey`, `ownership`,
`province`, `district`, `sector` (M7, nullable) and `countryCode`, `createdById`, `isActive`, `source`,
`updatedAt` (M11, with defaults); exactly 1,974 official schools after M8 (`adopted` existing rows +
`inserted` new ones); triggers on `User` (M4, M10). **M12 drops the unique
index `School_name_key`** (names may repeat).

**R5 — Application on the branch** (local, never Render).

1. API from `develop` (`npm run build`). The API fills every variable missing from the environment from
   `.env` **in its working directory** — so start it from an **empty directory outside the repository**
   (no `.env` is loaded at all): `cd <empty dir>; node <repo>\dist\main.js`. Set, in that shell only,
   with **non-empty** values (in PowerShell `$env:X = ''` deletes a variable instead of emptying it):
   `DATABASE_URL` = the branch (pooled is fine for the API; enter it without echoing, e.g. read it
   from `.env.drill.local`), `NODE_ENV=development` (production mode refuses to start without a real
   e-mail key), **`WORKERS_ENABLED=false`** (the copy contains the real e-mail outbox — workers would
   e-mail real people), **`RESEND_API_KEY=re_rehearsal_invalid`** (a key Resend rejects: nothing can be
   delivered), `STORAGE_DRIVER=local`, `JWT_SECRET` throwaway (≥ 32 chars), `APP_URL` and
   `CORS_ORIGINS` = `http://localhost:3000`, `TEACHERS_ENABLED=false`, `HEAD_COACHES_ENABLED=false`.
   `GET /health` = 200.
2. `GET /api/v1` → `capabilities.features` contains `schoolAdministration`, `schoolAffiliations`,
   `schoolReferenceRequired`, `academicYearActivation`; **no** `teacherAccounts`, `headCoachAccounts`.
3. Frontend `develop`: `API_PROXY_TARGET=http://127.0.0.1:<api port>` `npm run build && npm start`.
4. Owner, in the browser (credentials typed by the owner only):
   - Admin logs in; Users list loads; edit a test user's **name** only (no role change);
   - Schools → Directory shows 1,974 official + legacy schools; School verification lists PENDING
     claims (count = post-check §7) — verify **one** test claim, then **Revoke** it (leave data as found);
   - Academic Years: years listed; **do not start a year** on the copy unless rehearsing a rollover is
     explicitly approved;
   - one student and one coach (if their passwords are available to the owner): courses, assignments,
     results load. File downloads fail on local storage (expected — files live in R2).
5. Stop the API and frontend.

**R6 — Rollback rehearsal on a second branch.** Neon: new branch `rollback-phase1-<yyyymmdd>` from
`production`, current data; put its direct string in `.env.drill.local`; then:
`check-target` → `deploy --confirm <ep2>` → `postcheck` →
`rollback --confirm <ep2>` (exactly 14 files, M14→M1, each in its own transaction; the runner stops at
the first error and that file changes nothing; M12–M14 need no acknowledgement because no directory or
sync data exists yet) → `rollback-history --confirm <ep2>` (refused unless M9–M14's tables, enums, the
M10 trigger and `School.source` are gone and `School_name_key` is back; then deletes exactly the six
M9–M14 history rows) → `status` = the 14 names under "Following migrations have not yet been applied:"
(exit 1). Then prove the pre-Phase-1 state with the same checkout:
`node scripts/db-drill-verify.mjs --baseline pre-phase1 --trigger-test --json <file outside the repo>` →
rev 2 verifier line; 17/17 migrations, 46 tables (none missing, none unexpected), 0 orphaned rows.
Expected data difference from the original: `AuditLog` +4 system rows (kept by design). (Column-level
equality with `main`'s schema after a full rollback was proven on the local rehearsal of 2026-11-13.)

**R7 — Report and clean up.** Write `docs/operations/REHEARSAL-NEON-<date>.md` (counts, timings,
issues; no personal data, no connection strings). Delete both branches (they hold personal data) and
empty `.env.drill.local`. Owner approves before any release step.

## B. Backup / restore drill (Part B)

Goal: prove that a `pg_dump` backup restores completely, with the same tools and checks the release
day uses. The drill dumps the **rehearsal branch** (identical to production at its creation, no
production access). Production's own dump is taken in the release window (runbook §2.2), with the
owner's approval — the kit never connects to production.

Every step uses the reviewed checkout (see the top). The runner's `dump` and `restore`:
- go through the same guard as every command (refuse the production host, app databases and redirecting
  URLs) and need `--confirm <ep-id>`;
- never put a password on a command line: `pg_dump`/`pg_restore` get a connection string without it and
  the password through `PGPASSWORD` in their own environment only, with every other `PG*` variable
  removed (so `PGSERVICE`, `PGHOST`… cannot redirect them);
- `dump` writes only into an existing, absolute folder that is outside the repository, outside every
  OneDrive folder and **EFS-encrypted** (refused otherwise — the dump is never written unencrypted);
  refuses a `pg_dump` older than the server; deletes a partial file when `pg_dump` fails; then checks
  the file with `pg_restore --list` and prints its size, TABLE DATA count and SHA-256;
- `restore` reads only a dump in such a folder, refuses a target that has any table, and stops at the
  first error (`--exit-on-error`).
Any non-zero exit code means stop. (`dump`/`restore` are covered by unit tests of their checks; their
first run against a database is this drill — no PostgreSQL 18 client tools were available before.)

| Step | Action | Expected |
|---|---|---|
| B0 | install PostgreSQL **18** client tools (approval); `pg_dump --version` | 18.x |
| B1 | before R3, `DRILL_DATABASE_URL` = the rehearsal branch: `node scripts/db-drill-verify.mjs --baseline pre-phase1 --json <encrypted folder>\fp-source.json` | rev 2 verifier line; all checks pass (17 migrations, 46 tables); the JSON keeps the id fingerprints (no personal data) |
| B2 | `node scripts/release/rehearsal.mjs dump --out <encrypted folder> --confirm <ep-id>` | exit 0; `dump: rehearsal-<ep-id>-<time>.dump …; 47 TABLE DATA entries; sha256 …` (custom format is compressed: much smaller than the database) |
| B3 | Neon: new **empty** database `restore_drill` on the rollback branch (Databases → New); `DRILL_DATABASE_URL` = that database's direct string; `node scripts/release/rehearsal.mjs restore --dump <encrypted folder>\<file> --confirm <ep-id>` | exit 0 |
| B4 | `node scripts/db-drill-verify.mjs --baseline pre-phase1 --trigger-test --json <encrypted folder>\fp-restored.json` | all checks pass; every id fingerprint equals B1's |
| B5 | record the SHA-256 in the report; drop `restore_drill`; keep or delete the dump per the owner's decision (it stays in the encrypted folder) | recorded |

Files in R2 are not in the dump; a full recovery also needs an R2 copy taken at the same time
(docs/DEPLOYMENT.md §9) — not part of this drill.

## Timings to record

Branch creation → first connection; pre-check; `migrate deploy` (local: 5.5 s; production ~12 MB:
expect seconds); post-check; API start; rollback; `pg_dump`; `pg_restore`; verification.
