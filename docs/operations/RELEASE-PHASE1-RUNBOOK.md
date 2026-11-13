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

## 0. Before the window (days before)

1. **Code ready**: backend and frontend release branches merged into `develop` through PRs with green CI;
   frontend `develop` already on `main` and live (it works against the current backend and switches the
   new features on by itself when the new backend answers `GET /api/v1` with capabilities).
2. **Independent backup drill (Part B)**: `pg_dump` of production restored into a scratch database and
   verified (docs/operations/BACKUP-RESTORE-DRILL-2026-11-09.md — Part B has not been done yet).
3. **Rehearsal on a Neon branch of production** (point-in-time copy; never production itself):
   1. `psql "$BRANCH_URL" -f scripts/release/phase1-precheck.sql` — every MUST holds.
   2. `DATABASE_URL="$BRANCH_URL" npx prisma migrate deploy` — record the NOTICE lines (M3 counts,
      M8 adopted / inserted / uncoded, M9 with-school / name-only, M10 "0 violations; N diverged").
   3. Run the new API against the branch (local or a Render preview with `DATABASE_URL` = branch) and do
      §4 below. Run the frontend against it (`API_PROXY_TARGET`).
   4. Rehearse the rollback (§5) on a second branch, then re-apply.
   5. Write the rehearsal report (counts, timings, issues) and get the owner's approval.

## 1. Freeze (start of the window)

1. Announce the maintenance window to staff.
2. **Registration off**: `/admin/settings` → registration → student self-sign-up off
   (`registration.studentSelfSignup`, checked by `main`'s `auth.service.ts`).
3. Administrators agree not to invite, import, edit users' schools or roles, or touch academic years
   until §4 is done.
4. **Pause Render auto-deploy** for `rof-lms-api` (dashboard → Settings → Auto-Deploy: off), so the
   merge in §3 does not deploy before you are ready.

## 2. Backup and migrate

1. Neon: note the restore point (timestamp) and create a branch `pre-phase1-<date>` (instant copy).
   Neon Free keeps only 6 h of history: the branch is the fallback, not the history window.
2. `pg_dump --format=custom "$DIRECT_DATABASE_URL" > pre-phase1.dump` and check its size.
3. `psql "$DIRECT_DATABASE_URL" -f scripts/release/phase1-precheck.sql` — every MUST holds; the counts match
   the rehearsal (within the changes since).
4. `DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate status` → 14 pending.
5. `DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy` → "All migrations have been successfully applied."
   **Do not run the seed** (`db seed`) — nothing in it is needed and it adds MANUAL memberships.
   If a migration fails: stop; do not deploy; see §5.

## 3. Deploy

1. Merge backend `develop` into `main` (PR), then **Manual Deploy** the commit in Render (auto-deploy is paused).
2. Wait for `/health` = 200 on the new image.
3. Re-enable Render auto-deploy.

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

Then lift the freeze (registration on) and announce the end of the window.

## 5. Rollback

- **A migration failed** (nothing deployed yet): read the error; `prisma migrate status`. Either fix the
  cause and re-run `migrate deploy`, or roll back what was applied with the scripts in
  docs/migrations/ (reverse order; README there), or restore the `pre-phase1-<date>` Neon branch.
  The old code keeps running meanwhile — keep the freeze until the schema is back to the main baseline.
- **The new API misbehaves after the deploy**: redeploy the previous image **only together with**
  rolling the schema back (old code is incompatible with M10/M12 — see the table above). In practice:
  restore the `pre-phase1-<date>` branch as the primary database (data written since is lost — so decide
  quickly, before lifting the freeze), then redeploy `main`'s previous commit.
- After the freeze is lifted, prefer fixing forward.

## 6. After the release

- Every existing student's school claim is PENDING (M9): the school leaderboard counts only VERIFIED
  claims, so it is empty until administrators verify claims under **Schools → School verification**.
- Super Admin bootstrap, `TEACHERS_ENABLED`, `HEAD_COACHES_ENABLED`, `SUPER_ADMIN_BOUNDARY_ENABLED` and the
  directory sync are separate, later decisions (docs/operations/super-admin.md). Keep them off.
