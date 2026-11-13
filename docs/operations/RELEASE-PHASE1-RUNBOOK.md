# Phase 1 production release runbook (M1–M14 + API)

This releases backend `develop` (Phase 1: six roles, permissions, programmes, Teacher scope, school
directory, claims) and its 14 migrations to production. **Every production step needs the owner's
written approval** (docs/AI_COLLABORATION_PROTOCOL.md). Nothing here is automatic.

## Why the release needs a window

The migrations are **not** compatible with the code running in production today (`main`), and the new
code is not compatible with the old schema. There is no order without a gap, so the gap is made
short and harmless by freezing the writes that fail or leave bad data:

| Old code path (production `main`) | Breaks after | Why |
|---|---|---|
| An administrator changing a student's school, or a student's role (which clears the school) (`users.service.ts`) | **M10** `20261121000900_school_affiliation_integrity` | **Fails (500).** After M9 every student with a school has a PENDING claim; M10's trigger refuses a `User.schoolId` change the claim does not follow (`23514 AFFILIATION_SCHOOL_MISMATCH`). Reproduced on the local rehearsal (old `main` API on the migrated schema). |
| Academic-year rollover writing `User.schoolId` | **M10** | same trigger |
| Student self-registration, invitation and CSV import with a school name (`auth.service.ts` `school.upsert({ where: { name } })`, `user-provisioning.service.ts`) | M9 / M12 | **Still answers 201, but leaves bad data.** The student gets a school and **no claim** (M9's backfill has already run), so they never appear under School verification and a Teacher never sees them; the school is created from free text (the new code never does). M12 drops `School_name_key`; the old upsert keeps working only while no two schools share a name — true right after M8, not once the new code creates repeated names. Reproduced on the local rehearsal. |

The reverse (new code on the old schema) fails on every request that touches the new tables, and the
API does not check migrations at start-up. Render deploys `main` automatically (`render.yaml`), so
**merging to `main` is the deploy**: it must come *after* `migrate deploy`, never before.

## Roles

Fill in the names before the window. One person may hold several roles, except that the **verifier
is never the operator**.

| Role | Who | Responsibilities |
|---|---|---|
| Release owner | `<name>` (the owner) | approves the release SHA, every production step and the window; **makes every rollback decision** |
| Operator | `<name>` | runs the commands below, exactly as written, from the release checkout |
| Verifier | `<name>` | reads every output against the expected value before the next step starts; says "go" or "stop" |
| Communicator | `<name>` | announces the window, the freeze and its end to staff and administrators |

Keep a **release record** (§7) while you go: every SHA, time, command and result.

## 0. Before the window (days before)

1. **Code ready**: backend and frontend release branches merged into `develop` through PRs with green CI;
   frontend `develop` already on `main` and live (it works against the current backend and switches the
   new features on by itself when the new backend answers `GET /api/v1` with capabilities).
2. **Approve the release SHA.** The release owner writes down `APPROVED_RELEASE_SHA`: the full 40-character
   backend `develop` commit that is released (candidate today: `c3a4bd3015fe9de915a6da83fe60227b0a41f733`,
   the PR #38 merge — **needs the owner's approval**; any later merge into `develop`, for example a fix,
   gives a new candidate and a new rehearsal). It must:
   - contain the PR #38 migration guard (`git merge-base --is-ancestor 52537ad15d6507000ab94d9832e23e8266127670 <SHA>`
     exits 0);
   - have exactly 31 migrations, the last one M14 `20261121001300_school_directory_sync_approval`, and none
     after it (§2.0 checks this) — in particular **not** `20261201000000_teacher_applications` or
     `20261202000000_notification_outbox` (Teacher Registration is released separately, later);
   - have a green CI run on that exact SHA (GitHub Actions, workflow "CI", jobs `test` and `compose-smoke`).

   Also record `PREVIOUS_MAIN_SHA` = the backend `main` commit running in production now (today
   `a8df1860dd2dcc7a18fd26f1e1c36ec2bdb756fe`): it is what a rollback redeploys.
3. **Tools on the operator's machine**: PostgreSQL **18** client tools (`pg_dump`, `pg_restore`, `psql`;
   production is PostgreSQL 18.6) — `pg_dump --version`, `pg_restore --version` and `psql --version` all
   print 18.x; Node.js and npm as in CI; git. Installing them needs the owner's approval.
4. **Rehearsal and backup/restore drill (Part B) on Neon branches of production** (point-in-time
   copies; never production itself): docs/operations/REHEARSAL-NEON-CHECKLIST.md, step by step, with
   expected values, **from a checkout of `APPROVED_RELEASE_SHA`**. Everything runs from that checkout with
   its own tools — the guarded runner `scripts/release/rehearsal.mjs` (pre-check, migrate, post-check,
   rollback, `dump`, `restore`) and the hardened verifier `scripts/db-drill-verify.mjs`
   (`--baseline pre-phase1` for a copy before M1–M14); both print `db-drill-verify rev 2 (hardened target
   guard)` first. No other checkout (not `main`) is used. Part B dumps the rehearsal branch into an
   EFS-encrypted folder outside the repository and OneDrive, restores it into an empty database and
   compares id fingerprints (docs/operations/BACKUP-RESTORE-DRILL-2026-11-09.md — Part B has not been
   done yet).
5. **Rehearse the fallback**: on a throw-away Neon branch, carry out the restore procedure of §5.3 once
   (the exact Neon console steps, how long they take, and how the API reaches the restored data). It has
   not been rehearsed yet; do not rely on steps nobody has done.
6. Write the rehearsal report (`APPROVED_RELEASE_SHA`, counts, timings, issues, the fallback timing) and get
   the owner's written approval of the report, the window date and the rollback deadline (§5.1).

## 1. Freeze (start of the window)

1. Announce the maintenance window to staff.
2. **Registration off**: `/admin/settings` → registration → student self-sign-up off
   (`registration.studentSelfSignup`, checked by `main`'s `auth.service.ts`).
3. Administrators agree not to invite, import, edit users' schools or roles, or touch academic years
   until §4 is done.
4. **Pause Render auto-deploy** for `rof-lms-api` (dashboard → Settings → Auto-Deploy: off), so the
   merge in §3 does not deploy before you are ready.

## 2. Backup and migrate

The rehearsal kit refuses production by design, so the production steps are done by hand. What keeps
them safe is §2.0: **`prisma migrate deploy` applies exactly the migrations present in the checkout it
runs from** — a checkout of `APPROVED_RELEASE_SHA`, verified to contain M1–M14 and nothing after M14,
cannot apply a 15th or 16th migration. Never run a production command from an everyday working copy
(it may have a feature branch checked out — for example `feature/teacher-registration`, whose migrations
`20261201000000_teacher_applications` and `20261202000000_notification_outbox` would be applied too).

Commands are for Windows PowerShell on the operator's machine. The verifier checks each result before
the next step. **Any unexpected output: stop** and go to §5.

### 2.0 The release checkout (pinned to the approved SHA)

```powershell
cd <a folder outside OneDrive>
git clone https://github.com/Theoneste1/ROFBACKENDTEST.git rof-release-<date>
cd rof-release-<date>
git checkout --detach <APPROVED_RELEASE_SHA>
git rev-parse HEAD                     # MUST print APPROVED_RELEASE_SHA, all 40 characters
git status --porcelain                 # MUST print nothing
git merge-base --is-ancestor 52537ad15d6507000ab94d9832e23e8266127670 HEAD; $LASTEXITCODE   # MUST print 0 (PR #38 guard present)
node --input-type=module -e "import { migrationDirs, laterMigrations, PHASE1, PHASE1_COUNT } from './scripts/release/phase1.mjs'; const d = migrationDirs('.'); const later = laterMigrations(d); const p1 = d.filter((n) => PHASE1.test(n)); console.log(JSON.stringify({ total: d.length, phase1: p1.length, later })); process.exit(later.length === 0 && p1.length === PHASE1_COUNT && d.length === 31 ? 0 : 5);"
$LASTEXITCODE                          # MUST print 0, after {"total":31,"phase1":14,"later":[]}
npm ci
Test-Path .env                         # MUST print False (no .env in the release checkout)
Get-ChildItem env: | Where-Object Name -like 'DOTENV*'    # MUST print nothing
```

Any other output — a different SHA, a later migration, exit 5, or an error (a checkout from before
PR #38 fails with `does not provide an export named 'laterMigrations'`) — **stop**: wrong checkout. Do
not edit or delete migration folders to make a check pass.

### 2.1 Neon branch and production dump

1. Neon: note the restore point (timestamp) and create a branch `pre-phase1-<date>` (instant copy).
   Neon Free keeps only 6 h of history: the branch is the fallback, not the history window. Record the
   branch name and its endpoint id (`ep-…`).
2. Production dump with the PostgreSQL 18 tools (as rehearsed in Part B): the password only in the
   PostgreSQL password file (`%APPDATA%\postgresql\pgpass.conf`; `psql` in §2.3–§2.5 and §5 uses it too;
   delete it at the end of the window), never on a command line;
   `pg_dump --format=custom --no-owner --no-acl --file=<EFS-encrypted folder outside the repository and OneDrive>\pre-phase1-<date>.dump "host=<direct host> dbname=neondb user=<user> sslmode=require"`.
   Exit code 0, then `pg_restore --list` on the file succeeds (47 TABLE DATA entries); record its SHA-256
   (`Get-FileHash`). Any failure: stop.

### 2.2 Connection for the next steps (same PowerShell window; close it at the end)

`psql` reads its connection from libpq variables and the password from `pgpass.conf`; Prisma reads
`DATABASE_URL` from the environment. Neither value is typed on a command line:

```powershell
$env:PGHOST = '<direct host, no "-pooler">'; $env:PGDATABASE = 'neondb'; $env:PGUSER = '<user>'; $env:PGSSLMODE = 'require'
# Copy the production DIRECT connection string from the Neon console to the clipboard, then:
$env:DATABASE_URL = (Get-Clipboard -Raw).Trim(); Set-Clipboard -Value ' '
([uri]$env:DATABASE_URL).Host          # MUST equal $env:PGHOST (the direct endpoint, no "-pooler")
```

### 2.3 Pre-checks (read only)

1. Migration history — MUST print `later = 0`, `phase1 = 0`, `total = 17`,
   `last = 20261120000000_email_html_body`, `unfinished = 0`:

   ```powershell
   psql -X -v ON_ERROR_STOP=1 -c "SELECT count(*) FILTER (WHERE left(migration_name, 14) > '20261121001300') AS later, count(*) FILTER (WHERE migration_name LIKE '2026112100%') AS phase1, count(*) AS total, max(migration_name) AS last, count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL) AS unfinished FROM _prisma_migrations"
   ```

   (`later` compares the 14-digit timestamps only, as `scripts/release/phase1.mjs` does — digits sort the
   same in every collation.)
2. `psql -X -v ON_ERROR_STOP=1 -f scripts/release/phase1-precheck.sql` (runs in a READ ONLY transaction) —
   every MUST holds, in particular exactly one `MATHEMATICS` discipline (M3) and `diverged = 0` (M10); the
   counts match the rehearsal (within the changes since). Save the output in the release record.
3. `npx prisma migrate status` → "Following migrations have not yet been applied:" followed by **exactly**
   these 14 names, in this order, and nothing else (exit code 1 is expected):

   ```
   20261121000000_roles_teacher_head_coach_super_admin
   20261121000100_programme_membership
   20261121000200_backfill_programme_membership
   20261121000300_last_super_admin_guard
   20261121000400_permission_overrides
   20261121000500_teacher_school_assignment
   20261121000600_school_codes
   20261121000700_official_school_list
   20261121000800_student_school_affiliation
   20261121000900_school_affiliation_integrity
   20261121001000_school_administration
   20261121001100_school_directory_model
   20261121001200_school_directory_sync
   20261121001300_school_directory_sync_approval
   ```

### 2.4 Migrate

`npx prisma migrate deploy` → it lists the same 14 names as applied and ends with "All migrations have
been successfully applied." **Do not run the seed** (`db seed`) — nothing in it is needed and it adds
MANUAL memberships. If a migration fails: stop; do not deploy; §5.2.

### 2.5 Post-migration verification (before any deploy)

1. `npx prisma migrate status` → "Database schema is up to date!" (exit code 0).
2. `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` → exit code
   0 (no difference between the database and the release's schema). Exit code 2 = drift: stop, §5.2.
3. The history query of §2.3.1 again → `later = 0`, `phase1 = 14`, `total = 31`,
   `last = 20261121001300_school_directory_sync_approval`, `unfinished = 0`.
4. `psql -X -v ON_ERROR_STOP=1 -f scripts/release/phase1-postcheck.sql` (READ ONLY) — every MUST holds
   (14 Phase 1 migrations; 1974 coded `OFFICIAL_LIST` schools; `School_code_key` present and
   `School_name_key` absent; every M9 claim PENDING; both M10 invariants 0; triggers enabled); the
   "compare" lines equal the pre-check. Save the output in the release record.

Only when the verifier says "go" on all four: §3. Otherwise §5.2 (nothing is deployed yet, the old code
still runs, the freeze holds).

## 3. Deploy (pinned to the approved SHA)

1. Open the PR `develop` → `main` and check, before merging, that its head commit **is**
   `APPROVED_RELEASE_SHA` (if `develop` has moved since the approval, stop: the release is no longer the
   rehearsed one). Merge it.
2. Check that `main` now has exactly the approved code:
   `git fetch origin; git diff --stat <APPROVED_RELEASE_SHA> origin/main` → **prints nothing** (identical
   trees; a merge commit has another SHA but the same content). Record the new `main` SHA.
3. **Manual Deploy** that `main` commit in Render (auto-deploy is paused) and check in the Render dashboard
   that the deploy shows that commit.
4. Wait for `/health` = 200 on the new image, and `GET /api/v1` answers with `capabilities` (the old API
   has none).
5. Re-enable Render auto-deploy only after §4 (a later push to `main` must not deploy in the middle of
   the verification).

## 4. Verify (before lifting the freeze)

API (`https://<api>/api/v1`):
- `GET /api/v1` → `capabilities.features` contains `schoolAdministration`, `schoolAffiliations`,
  `schoolReferenceRequired`, `academicYearActivation`.
- Administrator: log in; `GET /me/permissions` lists `schools.manage`; `GET /admin/schools?limit=1` = 200;
  `GET /admin/school-affiliations?limit=1` = 200.
- A student and a coach can log in and open courses, assignments and results.

Frontend (production site):
- Admin: Users (edit a test user's name, no role change), Schools shows the directory, School verification
  opens, Academic Years shows the years (Start offered only for PLANNED years).
- Registration form shows the school directory (code / not listed / abroad); register a test student
  with an official code; the claim appears under School verification; verify it.
- Coach: courses, reviews; Student: assignments, submit, results.

Then the release owner says "go" for lifting the freeze: re-enable Render auto-deploy, registration on,
announce the end of the window. **Lifting the freeze is the point of no return** (§5.1).

## 5. Rollback

### 5.1 Who decides, and by when

- **Only the release owner decides** to roll back or to continue; the operator and the verifier stop and
  report, they do not improvise. If the release owner cannot be reached within 15 minutes, the default is
  **roll back** (§5.3) as long as the freeze has not been lifted.
- **Deadline:** the decision is taken **before the freeze is lifted**, and no later than
  `<agreed time, e.g. 60 minutes after the deploy>` (agreed in §0.6). Neon Free keeps only 6 h of history;
  the `pre-phase1-<date>` branch does not depend on it, but it ages: every minute after the freeze is lifted
  adds production data that a restore would lose.
- **Point of no return:** lifting the freeze. From then on new registrations, claims and edits are written
  under the new schema; restoring the `pre-phase1-<date>` branch would lose them. After it, fix forward;
  a restore needs the owner's explicit, written acceptance of that data loss.

| Situation | Decision | Steps |
|---|---|---|
| §2.0 checkout check or §2.3 pre-check fails | stop; nothing was changed | lift the freeze, investigate, new window |
| `migrate status` (§2.3.3) shows other names than the 14 | stop; nothing was changed | wrong checkout or wrong database: back to §2.0 / §2.2 |
| A migration fails during §2.4 | roll back | §5.2 |
| §2.5 verification fails (status, diff, history or a post-check MUST) | roll back | §5.2 (or §5.3 if unsure) |
| §4 verification fails after the deploy, freeze still on | roll back | §5.3 |
| A problem after the freeze was lifted | fix forward | restore only with written acceptance of data loss |

### 5.2 Before the deploy (the old code still runs)

Nothing new is deployed; keep the freeze until the schema is back to the `main` baseline.

1. `npx prisma migrate status` — which migrations are applied, and which one failed.
2. **Preferred when in doubt:** §5.3 (restore the `pre-phase1-<date>` branch; exact, rehearsed in §0.5).
3. Otherwise roll back what was applied with the scripts in docs/migrations/, **newest first**
   (docs/migrations/README.md; they were rehearsed on the Neon branch). For a migration that **failed**,
   first check which of its objects exist; run its rollback file only if it partly applied. Then mark it:
   `npx prisma migrate resolve --rolled-back <failed migration name>`.
4. M9–M14 rollbacks do not remove their own `_prisma_migrations` rows (README "Prisma migration history");
   remove them as described in each file, after the rollback has been verified, then `npx prisma migrate
   status` must list the 14 names as not applied again. Do not run `migrate deploy` in between.
5. Run §2.3.1 and `phase1-precheck.sql` again: the history is back to 17 rows and the pre-check matches the
   one taken before the migration. Then lift the freeze.

### 5.3 After the deploy (the new code runs; freeze still on)

The old code is incompatible with M10/M12 (table above), so the previous image is redeployed **only
together with** the old schema:

1. Pause Render auto-deploy (if it was re-enabled).
2. Make the API use the `pre-phase1-<date>` data, with the procedure rehearsed in §0.5 (Neon: restore the
   production branch from `pre-phase1-<date>`, or point the API at that branch — **verify the exact Neon
   console steps in the rehearsal; they are not written down here because nobody has done them yet**).
   Any change of `DATABASE_URL` in Render is a production setting change: the release owner approves it.
3. Redeploy `PREVIOUS_MAIN_SHA` in Render (Manual Deploy of that commit).
4. Check: `/health` = 200; `GET /api/v1` answers **without** `capabilities`; an administrator and a student can
   log in; the §2.3.1 history query shows 17 rows.
5. Frontend: no rollback needed — the released frontend works with the old backend (it shows the new
   features only when `GET /api/v1` advertises them). Check one admin and one student page.
6. Lift the freeze; record what happened; the release is re-planned.

## 7. Release record (fill in during the window)

| Item | Value |
|---|---|
| `APPROVED_RELEASE_SHA` (owner approval: date, by) | |
| CI run on that SHA (id, result) | |
| `PREVIOUS_MAIN_SHA` | |
| Release checkout path; §2.0 outputs (SHA, guard exit code, `{"total":31,"phase1":14,"later":[]}`) | |
| Freeze start / end (time) | |
| Neon branch `pre-phase1-<date>` (time, endpoint id) | |
| Dump file, size, TABLE DATA count, SHA-256 | |
| §2.3 history query, pre-check output, `migrate status` (14 names) | |
| §2.4 deploy output and duration | |
| §2.5 status / diff exit code / history query / post-check output | |
| New `main` SHA; `git diff --stat` empty; Render deploy commit | |
| §4 checks (who, result) | |
| Decision to lift the freeze (release owner, time) | |
| Anything unexpected | |

## 6. After the release

- Every existing student's school claim is PENDING (M9): the school leaderboard counts only VERIFIED
  claims, so it is empty until administrators verify claims under **Schools → School verification**.
  Claims are never approved in bulk; the workflow is in docs/operations/SCHOOL-CLAIM-VERIFICATION.md.
- Super Admin bootstrap, `TEACHERS_ENABLED`, `HEAD_COACHES_ENABLED`, `SUPER_ADMIN_BOUNDARY_ENABLED` and the
  directory sync are separate, later decisions (docs/operations/super-admin.md). Keep them off.
