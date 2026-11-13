# Phase 1 rehearsal on a Neon branch + backup/restore drill (Part B) — checklist

Executable version of RELEASE-PHASE1-RUNBOOK.md §0.2–0.3. **Nothing here touches production** except
step B1 (a read-only `pg_dump`, only if the owner chooses it over B1-alt). Every step needs the owner's
approval (docs/AI_COLLABORATION_PROTOCOL.md). Connection strings are never pasted into chat, issues,
commits, logs **or a command line** (shell history and the process list keep them); they live only in
git-ignored `.env.*.local` files and, for the PostgreSQL client tools, in a `pgpass` file (Part B).

Tools in the repository (backend `develop` once the commit that adds this file is merged):

| Tool | Does | Writes? |
|---|---|---|
| `node scripts/release/rehearsal.mjs <cmd>` | guarded runner (below) | only `deploy`, `rollback`, `rollback-history`, each with `--confirm <ep-id>` |
| `scripts/release/phase1-precheck.sql` | pre-flight MUSTs (M3/M10 aborts, roles, history) | no (READ ONLY transaction) |
| `scripts/release/phase1-postcheck.sql` | post-migration MUSTs | no (READ ONLY transaction) |
| `node scripts/db-drill-verify.mjs` | integrity + id fingerprints of a copy | no (one rolled-back trigger test) |

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
| **2 free branch slots** (Free plan: 10/project) | `rehearsal-…` and `rollback-…`; a 3rd only if B2 restores into Neon | check Branches page |
| `.env.production.local` with production `DATABASE_URL` (exists since the P0-04 drill) | guard identifies production to refuse it | exists — verify, don't print |
| `.env.drill.local` with `DRILL_DATABASE_URL=` (rewritten per branch) | the only target the tools accept | owner writes it |
| Node 24 + backend `develop` checkout with `npm ci` and `npm run build` | runner, Prisma 7.10 CLI, API | ready |
| **PostgreSQL 18 client tools** (`pg_dump`, `pg_restore`, `psql` 18.x) | Part B only: `pg_dump` must be ≥ the server's major version (production: 18.6) | **missing on this machine** — install needs approval (EDB "Command Line Tools" or `choco install postgresql18`) |
| Encrypted storage **outside OneDrive** for the dump (e.g. `C:\rof-backups\`, 7-Zip AES-256 or `age`) | the dump holds personal data; the repo folder is OneDrive-synced | owner decides location |
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

**Part B before R3:** if the backup drill uses the rehearsal branch (B1-alt), do B-fp and B1 **now** —
R3 changes the branch.

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
branch: all checks pass (31/31 migrations, every model has its table, 0 orphaned rows).

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
(exit 1). Prove the `main` baseline from a `main` checkout:
`prisma migrate status` up to date and `prisma migrate diff … --exit-code` no difference (with
`DATABASE_URL` = branch, in the shell only). Expected data difference from the original: `AuditLog` +4
system rows (kept by design).

**R7 — Report and clean up.** Write `docs/operations/REHEARSAL-NEON-<date>.md` (counts, timings,
issues; no personal data, no connection strings). Delete both branches (they hold personal data) and
empty `.env.drill.local`. Owner approves before any release step.

## B. Backup / restore drill (Part B)

Goal: a backup that survives outside Neon and beyond the 6-hour history, proven restorable.

Passwords: put each password in the PostgreSQL password file (`%APPDATA%\postgresql\pgpass.conf`,
lines `host:5432:neondb:user:password`, readable only by you) and give the tools a connection string
**without** a password, e.g. `"host=ep-… dbname=neondb user=… sslmode=require"` (host and user are not
secret). Delete those lines after the drill. After every command check the exit code
(PowerShell: `if ($LASTEXITCODE -ne 0) { throw "failed" }`); a non-zero code means stop.

| Step | Action | Expected |
|---|---|---|
| B0 | install PostgreSQL **18** client tools; `pg_dump --version` | 18.x (a `pg_dump` older than the server's major version refuses to dump) |
| B-fp | fingerprints of the source **before** dumping it: `DRILL_DATABASE_URL` = the source; `node scripts/db-drill-verify.mjs --json <file outside the repo>` from a **`main`** checkout (it compares against `main`'s 17 migrations; its guard predates the query-parameter/encoding hardening, so use the console string unchanged) | all checks pass; keep the JSON (id fingerprints) |
| B1 | `pg_dump --format=custom --no-owner --no-acl --file=<encrypted folder>\pre-phase1-<date>.dump "<conninfo without password>"` against **production** — reads production, **needs explicit approval** | exit 0; `pg_restore --list <dump>` lists the 47 tables' data entries (custom format is compressed: the file is much smaller than the database) |
| B1-alt | same against the **rehearsal branch**, after B-fp and before R3 (identical data, no production access) — proves the tooling; production's own dump is then taken on release day (runbook §2.2) | as B1 |
| B2 | an **empty** target: a new database `restore_drill` on a drill branch (Neon → Databases → New) or a local PostgreSQL 18 server; `pg_restore --no-owner --no-acl --exit-on-error -d "<conninfo without password>" <dump>` | exit 0 (`--exit-on-error` stops at the first error; a non-empty target fails at once) |
| B3 | `DRILL_DATABASE_URL` = the restore target; `node scripts/db-drill-verify.mjs --trigger-test --json <file>` from the **`main`** checkout | all checks pass; every id fingerprint equals B-fp's |
| B4 | record the dump's SHA-256 (`Get-FileHash`); keep it only in the encrypted folder **outside OneDrive** (an EFS-encrypted folder, `cipher /e`, or a BitLocker/VeraCrypt volume — the dump is never written unencrypted); drop `restore_drill` | recorded in the report |

Files in R2 are not in the dump; a full recovery also needs an R2 copy taken at the same time
(docs/DEPLOYMENT.md §9) — not part of this drill.

## Timings to record

Branch creation → first connection; pre-check; `migrate deploy` (local: 5.5 s; production ~12 MB:
expect seconds); post-check; API start; rollback; `pg_dump`; `pg_restore`; verification.
