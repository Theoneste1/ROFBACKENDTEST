# Deploying the ROF LMS API

This guide takes the API from a clean environment to production, and covers
upgrades, backups, recovery and monitoring. Read it end to end before the
first deployment.

Contents: [Architecture](#1-production-architecture) ·
[Configuration](#2-environment-configuration) ·
[Database](#3-database) · [Authentication](#4-authentication) ·
[File storage](#5-file-storage) · [Reverse proxy](#6-reverse-proxy-and-tls) ·
[First deployment](#7-first-deployment) · [Upgrades and migrations](#8-releasing-a-new-version) ·
[Backup and recovery](#9-backup-and-recovery) · [Monitoring and logging](#10-monitoring-and-logging) ·
[Scaling](#11-scaling) · [Data protection](#12-data-protection) ·
[Go-live checklist](#13-go-live-checklist)

---

## 1. Production architecture

| Component | Recommendation |
|---|---|
| API | The Docker image from `Dockerfile` (`runtime` target), 1+ instances. Node.js 24, runs as the unprivileged `node` user, built-in `HEALTHCHECK` |
| Database | Managed PostgreSQL 14+ (16 recommended) with TLS, daily backups and point-in-time recovery |
| Files | Private S3-compatible bucket (AWS S3, Cloudflare R2, MinIO …) with versioning |
| E-mail | [Resend](https://resend.com), with the sender domain verified (DKIM/SPF) — see [EMAIL.md](EMAIL.md) |
| TLS / edge | Reverse proxy or load balancer (Caddy, Nginx, cloud LB) terminating HTTPS |
| Logs | A log platform that ingests JSON from stdout (Loki, CloudWatch, Datadog, ELK …) |

The API keeps no state on its own disk when `STORAGE_DRIVER=s3`, so instances
can be replaced or added freely. Background jobs (e-mail outbox,
deadline closing, clean-up) run inside the API process and coordinate through
the database.

## 2. Environment configuration

Start from [`.env.production.example`](../.env.production.example). Keep the
real values in your secret store or orchestrator (never in git). All
variables, with defaults, are documented in [`.env.example`](../.env.example).

The API **validates its configuration at startup** and exits with a clear
message when something is wrong. In production it additionally requires
`RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL` and `CORS_ORIGINS`.

| Variable | Production value |
|---|---|
| `NODE_ENV` | `production` (JSON logs, secure cookies, Swagger off, e-mail verification on by default) |
| `DATABASE_URL` | Managed PostgreSQL URL, with `sslmode=require` |
| `DATABASE_POOL_MAX` | `10` per instance (see §11) |
| `JWT_SECRET` | 48+ random characters (§4) |
| `CORS_ORIGINS` | The frontend origin(s), comma-separated, e.g. `https://lms.rof.rw` |
| `APP_URL` | The frontend URL used in e-mail links |
| `APP_TIMEZONE` | `Africa/Kigali` |
| `TRUST_PROXY` | `1` behind one proxy/LB; `false` if clients reach the API directly |
| `MAX_UPLOAD_REQUEST_MB` | `100` — and the same limit in the proxy |
| `STORAGE_DRIVER` + `S3_*` | `s3` and the bucket's settings (§5) |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` | Resend key; `Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>`; `info@rwandaolympiadfoundation.org`. Leave `EMAIL_REDIRECT_TO` unset ([EMAIL.md](EMAIL.md)) |
| `WORKERS_ENABLED` | `true` (or see §11) |
| `SWAGGER_ENABLED` | `false` unless you deliberately expose `/api/docs` |
| `SEED_ADMIN_*` | First deployment only (§7) |

## 3. Database

1. Create a PostgreSQL 14+ database and a dedicated login with rights to
   create tables, indexes, functions and triggers in its schema. The
   migrations create two trigger functions for the audit log.
2. Require TLS (`sslmode=require` in `DATABASE_URL`) and restrict network
   access to the API and your admin hosts.
3. Enable automated daily backups and point-in-time recovery (§9).
4. Size `max_connections` for `instances × DATABASE_POOL_MAX`, plus a few for
   the migrate step and administrators.

The schema is created and upgraded only by `prisma migrate deploy`, which
applies new migrations in order and never deletes data. The migration history
(`prisma/migrations/`) starts from a baseline on 2026-11-03; every later
migration is additive and is listed in
[DATABASE.md §8](DATABASE.md#8-migrations).

> **Never** run `prisma migrate reset`, `prisma migrate dev` or `prisma db push`
> against production. They can drop data.

## 4. Authentication

- **`JWT_SECRET`** signs access tokens (HS256, 15 minutes). Generate it with
  `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
  Rotating it immediately signs every user out; refresh tokens are unaffected,
  so users get new access tokens on their next refresh.
- **Refresh tokens** (`REFRESH_TOKEN_TTL_DAYS`, default 30):
  - stored hashed, rotated on every use;
  - reuse of an old token revokes the whole session family;
  - browsers get them as an `httpOnly; Secure; SameSite=Strict` cookie,
    scoped to `/api/v1/auth`, so the frontend and API must be served over
    HTTPS.
- **Sign-up and accounts:**
  - e-mail verification for self-registration is on by default in production
    (system setting `registration.requireEmailVerification`);
  - administrators create or invite users of any role;
  - mentor applications need an administrator's approval, followed by e-mail
    confirmation.
- **Protection:**
  - per-IP rate limits (`THROTTLE_*`, stricter on credential endpoints);
  - a per-account lockout after 5 wrong passwords (15 minutes);
  - suspending a user, changing their role or their password ends their
    sessions immediately.

## 5. File storage

1. Create a **private** bucket (no public access, no website hosting). Enable
   **versioning**, and optionally a lifecycle rule that expires old versions
   after, for example, 90 days.
2. Create an access key limited to that bucket, with `s3:GetObject`,
   `s3:PutObject`, `s3:DeleteObject` and `s3:ListBucket`.
3. Set `STORAGE_DRIVER=s3` and the `S3_*` variables. For Cloudflare R2, set
   `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com` and
   `S3_REGION=auto`. For MinIO, also set `S3_FORCE_PATH_STYLE=true`.
4. After deploying, check that `GET /health` reports `"storage":"up"`, upload a
   test file, and download it again.

Files are always streamed through the API after an access check; nothing is
served from the bucket directly. Limits, allowed types and the clean-up job
are described in [STORAGE.md](STORAGE.md). The local driver (`STORAGE_DRIVER=local`)
is only suitable for a single instance with a persistent volume mounted at
`UPLOAD_DIR`.

## 6. Reverse proxy and TLS

Terminate HTTPS at the proxy and forward to the API's port. Keep the body
limit equal to `MAX_UPLOAD_REQUEST_MB`, and keep the proxy's access log on:
the API logs errors, not every request.

Caddy:

```
api.lms.example.org {
  reverse_proxy 127.0.0.1:3000
  request_body { max_size 100MB }
  log { output file /var/log/caddy/rof-api.log }
}
```

Nginx:

```nginx
server {
  listen 443 ssl http2;
  server_name api.lms.example.org;
  client_max_body_size 100m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
  }
}
```

With exactly one proxy in front, keep `TRUST_PROXY=1`. Add one per extra hop
(for example, CDN → load balancer → API = `2`). Never leave the API port
reachable from the internet when `TRUST_PROXY` is not `false`: a forged
`X-Forwarded-For` header would otherwise get around the per-IP rate limits.

## 7. First deployment

```bash
# 1. Build the two images (CI builds the runtime image on every push).
docker build --target runtime -t rof-api:<version> .
docker build --target migrate -t rof-migrate:<version> .

# 2. Create the schema and seed reference data (divisions, the four courses,
#    the current academic year, the first administrator). Idempotent.
docker run --rm --env-file .env.production rof-migrate:<version>
#    = prisma migrate deploy && prisma db seed

# 3. Start the API.
docker run -d --name rof-api --restart unless-stopped \
  --env-file .env.production -p 127.0.0.1:3000:3000 rof-api:<version>

# 4. Check it.
curl -fsS https://api.lms.example.org/health
#    {"status":"ok","checks":{"database":"up","storage":"up"},…}
```

Then:

1. Log in as the seeded administrator (`SEED_ADMIN_USERNAME` /
   `SEED_ADMIN_PASSWORD`) and change the password immediately
   (`PATCH /api/v1/auth/password`). Remove `SEED_ADMIN_PASSWORD` from the
   environment.
2. Check the academic year that was seeded (`GET /api/v1/academic-years/current`)
   and correct it, or create and activate the right one, under
   **/admin/academic-years**.
3. In **/admin/settings**:
   - set the platform name and the support contacts;
   - review the registration settings (e-mail verification is on);
   - review the notification rules and the assignment defaults.
4. Create mentors (`POST /api/v1/admin/users` or `/invite`) and give them
   courses and divisions (`POST /api/v1/admin/mentor-assignments`).
5. Send a test e-mail by inviting yourself, and confirm it arrives.

## 8. Releasing a new version

1. **Back up first.** Take an on-demand database snapshot (§9).
2. **Migrate.** Run the migrate image of the new version, as in §7 step 2. It
   applies only the new migrations; the seed step is idempotent and leaves
   existing data alone. Each migration's header says what it changes.
3. **Roll out.** Replace the API containers, one at a time when you have
   several. Check first whether the previous version can run against the
   migrated schema: **the Phase 1 migrations (M1–M14) are not additive for
   the old code** — M10's trigger refuses old edits of a student's school
   (500), and old registrations / invitations create students without a
   school claim (after M9's backfill) and schools from free text. That
   release needs a freeze window and its own procedure:
   docs/operations/RELEASE-PHASE1-RUNBOOK.md.
4. **Verify.** Check `GET /health`, log in, and open one page of each main area.

**If a migration fails**, `migrate deploy` stops, records the migration as
failed in `_prisma_migrations`, and refuses to apply anything further until
that is resolved. To recover:

1. Read the error, usually permissions or a lock timeout.
2. Check which of the migration's statements took effect, by comparing the
   database with the migration's SQL.
3. Undo any partial changes. Each migration's statements are additive, so
   this means dropping what it created.
4. Run `npx prisma migrate resolve --rolled-back <migration_name>`.
5. Fix the cause and deploy again.

Do not edit a migration that has already been applied anywhere. Restoring the
pre-release snapshot (step 1) is always a fallback.

**Rolling back the code** is safe only while the previous image works against
the new schema (check each migration; it is **not** the case across M1–M14,
see the Phase 1 runbook). Otherwise roll the schema back with it
(docs/migrations/) or restore the pre-release backup.

Adding indexes takes a short write lock on each table. On large tables,
schedule upgrades that add indexes outside teaching hours.

## 9. Backup and recovery

**Database:**
- Rely on the managed provider's daily backups and point-in-time recovery
  (keep at least 14 days).
- Also keep an independent logical backup, outside the provider, for example
  daily or before each release:

  ```bash
  pg_dump --format=custom --no-owner --no-privileges \
    --file=rof-$(date +%F).dump "$DATABASE_URL"
  # encrypt and copy it off-site, e.g.:
  gpg --symmetric --cipher-algo AES256 rof-$(date +%F).dump
  ```

**Files:** bucket versioning protects against deletion and overwrite. Also
replicate the bucket to a second location (provider replication,
`rclone sync` or `mc mirror` on a schedule).

**What a backup must include:** the database and the files from the same
time. Restoring one without the other leaves attachments that can't be
downloaded (they return 404). Secrets (`JWT_SECRET`, the Resend and S3 keys) live in
your secret store; back that up separately.

**Restoring** (always into a new database first, never over production):

```bash
createdb rof_restore
pg_restore --no-owner --no-privileges --dbname="postgresql://…/rof_restore" rof-YYYY-MM-DD.dump
DATABASE_URL="postgresql://…/rof_restore" npx prisma migrate status   # must say "up to date"
```

Then point a staging API at it (with a copy of the files) and check logins,
results and file downloads before switching production over.

**Restore drill:** restore the latest backup into staging once per term and
record how long it took. Latest drill: [docs/operations/BACKUP-RESTORE-DRILL-2026-11-09.md](operations/BACKUP-RESTORE-DRILL-2026-11-09.md)
(Neon point-in-time branch, verified with `scripts/db-drill-verify.mjs`).

Two notes on the audit log:
- It is append-only: a database trigger rejects UPDATE and DELETE on its rows.
  `pg_dump`/`pg_restore` carry the triggers with the data, and restoring is
  unaffected.
- A database administrator who genuinely needs to purge audit rows must drop
  the trigger deliberately; record that decision.

## 10. Monitoring and logging

**Health:**
- `GET /health` returns `200 {"status":"ok","checks":{"database":"up","storage":"up"}}`,
  or `503` when either is down.
- Use it as the readiness check, and for the load balancer and the image's
  `HEALTHCHECK`.
- It queries the database and storage on every call, so poll it every 15–30 s,
  not more often.

**Logs:**
- In production the API writes JSON lines to stdout; ship them to your log
  platform.
- Server errors (5xx) are logged with `[requestId] METHOD path → status`.
  Clients receive the same id in the `X-Request-Id` header and in every error
  body, so a user's error report can be traced to its log line.
- Background jobs log what they did and any failures: e-mail outbox,
  deadline closing, retention, token and file clean-up.
- Per-request access logs come from the reverse proxy (§6).
- Passwords, tokens and request bodies are never logged.

**Alert on:**

| Signal | Where | Suggested threshold |
|---|---|---|
| API down / not ready | `/health` ≠ 200 | 2 consecutive failures |
| Server errors | 5xx in proxy logs or `ExceptionFilter` lines | > 1% of requests over 5 min |
| Latency | proxy logs | p95 > 1 s over 10 min |
| E-mail failing | `GET /api/v1/admin/reports/overview` → `actionRequired.failedEmails`; `EmailWorker` warnings | any increase |
| Database | provider metrics: connections, CPU, storage, replication lag | 80% of limits |
| Brute force | many 401s on `/auth/login`; `LOCK_ACCOUNT` entries in the audit log | spikes |
| Disk / bucket | provider metrics | 80% |

**Audit trail:** administrators review it under **/admin/audit-logs** (filter
by category, actor or record, and export as CSV). Exports are audited too.

## 11. Scaling

- With `STORAGE_DRIVER=s3`, run as many API instances as you need behind the
  load balancer.
- `instances × DATABASE_POOL_MAX` must stay below the database's connection
  limit.
- Background jobs are safe on several instances: each claims its work with a
  conditional update, so nothing is sent or processed twice. To run them on
  one instance only, set `WORKERS_ENABLED=false` on the others.
- **Rate limits are counted per instance** (in memory). With N instances, a
  client can make up to N × `THROTTLE_LIMIT` requests per window. If that
  matters, enforce limits at the proxy/LB as well. The per-account login
  lockout is stored in the database and applies across instances.
- Uploads are checked in memory before they are stored. Size each instance's
  memory for concurrent uploads: the worst case is about
  `MAX_UPLOAD_REQUEST_MB` per in-flight upload request.

## 12. Data protection

Most users are minors. The platform follows data-minimisation defaults:

- students see other students as first name and last initial only, with no
  username, on the leaderboard and in discussions. Staff appear in full.
  Tested from each viewpoint;
- e-mail addresses and other contact details are visible to administrators
  only (tested: no student-facing response contains another user's e-mail);
- every report export is audited.

Confirm the hosting location and retention periods with Rwanda's personal
data protection law (Law N° 058/2021) before go-live. Retention jobs remove:

- activity logs after 400 days;
- read notifications after 180 days;
- the bodies of sent bulk e-mails after 90 days. Individual e-mails, which
  may contain links, lose their body as soon as they are sent.

## 13. Go-live checklist

- [ ] Secrets set in the secret store: `JWT_SECRET` (48+ chars), database,
      S3, Resend. `.env.production` is not in git.
- [ ] `NODE_ENV=production`, `CORS_ORIGINS` and `APP_URL` set to the real
      frontend, `TRUST_PROXY` matches the proxy chain.
- [ ] Database: TLS, backups and PITR on, connection limit sized,
      `migrate deploy` succeeded, `prisma migrate status` up to date.
- [ ] Bucket: private, versioned, replicated; key limited to the bucket;
      `/health` storage up; test upload and download done.
- [ ] E-mail: domain verified in Resend, DMARC record in place, `npm run email:check -- <inbox>` delivered, invitation and password-reset e-mails received (docs/EMAIL.md §8).
- [ ] Proxy: HTTPS only, body limit = `MAX_UPLOAD_REQUEST_MB`, access log on,
      API port not reachable from the internet.
- [ ] Seeded admin password changed and `SEED_ADMIN_PASSWORD` removed.
- [ ] Academic year, settings (platform name, support contacts,
      registration, notification rules) reviewed.
- [ ] Monitoring: `/health` probe, log shipping, alerts from §10.
- [ ] Restore drill done once (§9).
