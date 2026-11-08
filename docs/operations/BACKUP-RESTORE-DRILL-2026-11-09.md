# Backup and restore drill — P0-04 (Part A: Neon point-in-time recovery)

**Date:** 2026-11-08/09 (verification 23:00–23:03 UTC) · **Scope approved:** Part A only · **Result:** **recovery verified — 10/10 data checks, Prisma status and drift checks, and API health passed.**
Part B (independent `pg_dump` backup) has **not** been run; it awaits approval.

No production data, configuration or settings were changed. Neon *Instant Restore* (which overwrites the branch it
restores) was **not** used. No credentials, connection strings or personal data appear in this report.

## 1. Setup at the time of the drill

| Item | Value |
|---|---|
| Provider / plan | Neon, Free plan, AWS us-east-2 |
| Production database | PostgreSQL 18.6, 12 MB, 47 tables, 17 migrations, 2 audit-log triggers, extension `plpgsql` only |
| Provider protection (Free plan) | 6-hour history window (point-in-time), 10 branches/project, 1 manual snapshot; no daily backups beyond the window |
| Independent backup | none yet (Part B) |
| Recovery target | Neon branch `br-cold-band-bdlhpjxj`, parent `production`, **Past data** (exact recovery point not recorded — see 1.1), auto-delete 2026-11-10 00:52 GMT+2 (≈1 day) |

### 1.1 Recovery point (not exactly known)

The exact timestamp accepted by the Neon console was **not recorded** and could not be retrieved: Neon does not expose
it inside the restored database, and no Neon console or API access was used for verification. It is **not** stated
here as a fact. What is known:

| Bound | Value | Source |
|---|---|---|
| Earliest point offered by the console | 2026-11-08 18:49 Africa/Kigali (16:49 UTC) | owner, while creating the branch (start of the 6-hour window) |
| Lower bound from data | ≥ 2026-11-08 11:21:52 UTC (13:21:52 Kigali) | newest timestamp in the recovery branch (`AuditLog.createdAt`; read-only `max()` per table, no record contents) |
| Upper bound | ≤ branch creation, ≈ 2026-11-08 22:52 UTC | inferred from the 1-day auto-delete time; not an exact creation time |

The production writes missing from the branch (3.3) happened after the recovery point; their times were not read,
because database access was limited to the recovery branch. To record the exact point, read it from the branch's
details in the Neon console (or the Neon API, `GET /projects/{id}/branches/{branch_id}`: `parent_timestamp`) before the
branch is deleted.

## 2. Procedure used (repeatable)

1. **Owner, Neon console:** Branches → New branch → parent `production` → *Past data* (pick a time inside the 6-hour window) → name → auto-delete → Create. Production is not modified (copy-on-write child branch).
2. **Owner:** save the branch connection string as `DRILL_DATABASE_URL` in `.env.drill.local` (git-ignored by `.env.*.local`). Never paste it into chat, issues or commits.
3. **Verify (read-only):** `node scripts/db-drill-verify.mjs --trigger-test --json <file outside the repo>`
   - reads only `DRILL_DATABASE_URL`; refuses to run if the host is the production host; a pooled string is switched to the same branch's direct endpoint in memory;
   - prints only counts, object names and hashes.
4. **Prisma, recovery branch only:** `prisma migrate status` and `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` with `DATABASE_URL` set (in memory) to the recovery branch's direct endpoint.
5. **API health:** start `dist/main.js` locally against the recovery branch with `WORKERS_ENABLED=false` (no e-mail outbox, deadline, retention or clean-up jobs — the copy contains the e-mail outbox), `RESEND_API_KEY=` (dry run), `STORAGE_DRIVER=local`; request `/health`; stop the process.
6. **Owner:** review, then delete the branch (or let it auto-delete).

## 3. Results

### 3.1 Data checks (`scripts/db-drill-verify.mjs --trigger-test`)

| # | Check | Result |
|---|---|---|
| 1 | Connected, read-only session | ✔ `neondb`, PostgreSQL 18.6, 12 MB |
| 2 | Migrations | ✔ 17/17 repository migrations applied, 0 failed, 0 missing, 0 unknown |
| 3 | Tables | ✔ all 46 Prisma models present (47 tables incl. `_prisma_migrations`), none extra |
| 4 | Row counts (exact) | ✔ 225 rows (see 3.3) |
| 5 | Foreign-key integrity | ✔ 87 foreign keys checked, **0 orphaned rows** |
| 6 | Indexes and constraints | ✔ 188 indexes, 47 primary keys (uniqueness enforced by unique indexes) |
| 7 | Audit-log triggers | ✔ `audit_log_append_only` and `audit_log_fill_actor` present and enabled |
| 8 | Audit log append-only | ✔ `UPDATE "AuditLog"` **rejected** ("AuditLog is append-only: UPDATE is not allowed") inside a transaction that was rolled back |
| 9 | Id fingerprints | ✔ computed for 22 non-empty tables (3.4) |
| 10 | Representative aggregates | ✔ readable: users ADMIN 1 / MENTOR 2 / STUDENT 6 (all active, activated, approved, with password hash); 4 published courses; divisions JUNIOR, SENIOR; current academic year 2026-2027 ACTIVE; 4 stored files (RESOURCE) |

### 3.2 Prisma and API

| Check | Result |
|---|---|
| `prisma migrate status` (recovery branch) | ✔ "17 migrations found … Database schema is up to date!" |
| `prisma migrate diff … --exit-code` (recovery branch → `schema.prisma`) | ✔ "No difference detected." (exit 0) |
| Local API `/health` on the recovery branch | ✔ HTTP 200 `{"status":"ok","checks":{"database":"up","storage":"up"}}` (storage = local disk in this test); e-mail dry run, workers off; process stopped afterwards |

### 3.3 Row counts — recovery branch vs production before the drill

Production values are **statistics estimates** (`pg_stat_user_tables.n_live_tup`) taken read-only at ≈22:20 UTC,
before Part A; exact production counts were not taken because the approved scope limits database operations to the
recovery branch. The recovery branch reflects an earlier point in time, so later activity is expected to be missing.

| Table | Production (estimate) | Recovery (exact) | Note |
|---|---|---|---|
| User | 11 | 9 | 2 accounts created after the recovery point |
| AuditLog | 66 | 60 | later audited actions |
| ActivityLog | 23 | 20 | later activity |
| AccountActivationToken | 8 | 7 | later invitation/registration |
| StudentEnrollment / CourseEnrollment | 7 / 2 | 6 / 1 | later registration / course opening |
| EmailDelivery | 21 | 19 | later e-mails |
| RefreshToken | 39 | 53 | production's hourly clean-up removed expired tokens after the recovery point; estimates also lag |
| AcademicYear, Comment, CommentReaction, Course, CourseResource, Discipline, DiscussionThread, Division, FileObject, MentorAssignment, Notification, ResourceAttachment, School, SystemSetting, `_prisma_migrations` | identical | identical | reference and content data unchanged |

### 3.4 Id fingerprints (recovery branch)

First 16 hex characters of `md5(string_agg(id, ',' ORDER BY id))` per table — identifies the exact set of rows
without revealing content; used to compare a later restore (e.g. Part B) taken at the same point.

`AcademicYear 59f887fa8747390b` · `AccountActivationToken 499573108d430ffd` · `ActivityLog cfd31a00f72df439` ·
`AuditLog dbe73a655ce4738a` · `Comment f2b184c522536b34` · `CommentReaction d5caf9f78b82f5d5` ·
`Course c87e9cf1f24ca03f` · `CourseEnrollment e47f1e4bcdccf849` · `CourseResource 84ee2e5027a9d7ba` ·
`Discipline 3e6c95894387026e` · `DiscussionThread 246957002639067b` · `Division 50b9855f3175240b` ·
`EmailDelivery feb7c636bde903d9` · `FileObject bcb602652760e1e0` · `MentorAssignment 5ef25c2400457457` ·
`Notification 848fb9e7925a8da4` · `RefreshToken fb80ad332f1ece28` · `ResourceAttachment 3e3041dcb609c58e` ·
`School 5c97a838ae615901` · `StudentEnrollment 892de2c7efe8147f` · `User a690ea756e093cbc` ·
`_prisma_migrations dfc64c95d726ab7b`

## 4. Timings

| Step | Time |
|---|---|
| Branch creation (owner, console) | seconds (Neon copy-on-write; exact owner timing not recorded) |
| First connection to the new branch's compute (cold start) | 2.2 s (1.6 s warm) |
| Full data verification (10 checks) | 60.5 s |
| `prisma migrate status` / `migrate diff` | 11.4 s / 12.7 s |
| API start to healthy on the recovery branch | 4.1 s |
| **Verification to a confirmed, usable database** | **≈ 1.5 minutes of checks** (connection + data checks + API health; Prisma checks add ≈ 25 s). Time from branch creation to first connection was not measured. |

## 5. Limitations

- **Only Neon-internal recovery was tested.** The Free plan keeps **6 hours** of history: data damaged and noticed later than that cannot be recovered from Neon, and there is still **no independent backup** (Part B).
- The exact recovery point and the exact branch-creation time were not recorded and could not be retrieved from the database; only bounds are documented (1.1). Recovery time is therefore measured from the first connection, not from the recovery decision.
- Production comparison used statistics estimates, not exact counts (scope limited to the recovery branch).
- Uploaded files (Cloudflare R2) were not part of this drill; a real recovery needs the database **and** the files from the same moment (`docs/DEPLOYMENT.md` §9).
- The API test used local storage and dry-run e-mail; logins and file downloads were not exercised (no credentials used, files not restored).
- Neon *Instant Restore* (in-place) was deliberately not exercised; it overwrites the target branch and must never be pointed at production without a decision.
- The recovery branch contains personal data; it must be deleted after review (auto-delete is set to ≈1 day).

## 6. Recommendations

1. **Run Part B** (approved separately): install PostgreSQL 18 client tools, take an encrypted `pg_dump` via the direct connection, restore it into an empty database on a drill branch and compare with the fingerprints above. This gives a backup that survives beyond 6 hours and outside Neon.
2. **Schedule an off-site logical backup** (e.g. daily) — the GitHub Actions + S3/R2 pattern Neon documents, with encryption and a retention policy; keep a manual dump before every migration (Phase 1 onwards).
3. **Consider Neon Launch** (7-day history) before real users depend on the platform, or accept the 6-hour window plus daily dumps explicitly.
4. **Include R2 in recovery:** bucket-to-bucket copy or `rclone` of `rof-files`, taken at the same time as the database dump.
5. **Repeat this drill** before each structural migration (ADR-015) and at least once per term; record exact timestamps.
6. Delete drill branches promptly; never point Instant Restore at `production` without an explicit decision.
