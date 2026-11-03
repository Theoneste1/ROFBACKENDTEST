# Deploying the ROF LMS API

## What you need

| Component | Recommendation |
|---|---|
| API | The Docker image from `Dockerfile` (`runtime` target), 1+ instances |
| Database | Managed PostgreSQL 14+ with daily backups and point-in-time recovery |
| Files | S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, …), private |
| E-mail | An SMTP provider (SendGrid, Mailgun, Amazon SES, …) |
| TLS | Reverse proxy or load balancer (Caddy, Nginx, cloud LB) in front of the API |

The API is stateless; with `STORAGE_DRIVER=s3` you can run several instances.

## Configuration

Copy `.env.example` and set at least:

```
NODE_ENV=production
DATABASE_URL=postgresql://…
JWT_SECRET=<48+ random characters>
CORS_ORIGINS=https://lms.example.org
APP_URL=https://lms.example.org
# E-mail verification for sign-ups is on by default in production (system
# setting registration.requireEmailVerification), so SMTP must work.
APP_TIMEZONE=Africa/Kigali   # optional; live-session dates and times (IANA name)
STORAGE_DRIVER=s3
S3_BUCKET=… S3_REGION=… S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… (S3_ENDPOINT for non-AWS)
SMTP_HOST=… SMTP_PORT=… SMTP_USER=… SMTP_PASS=… EMAIL_FROM=…
```

The process exits at startup with a clear message if anything required is
missing (in production `SMTP_HOST` and `CORS_ORIGINS` are mandatory).

## Release procedure

```bash
# 1. Build
docker build --target runtime -t rof-api:<version> .
docker build --target migrate -t rof-migrate:<version> .

# 2. Migrate (once per release, before starting new API containers)
docker run --rm --env-file .env.production rof-migrate:<version>
#    = prisma migrate deploy && prisma db seed   (seed is idempotent)

# 3. Roll out
docker run -d --env-file .env.production -p 3000:3000 rof-api:<version>
```

- `prisma migrate deploy` only applies new migrations; it never resets data.
  **Never run `prisma migrate reset` or `migrate dev` against production.**
- On the very first deployment, set `SEED_ADMIN_PASSWORD` (or read the
  generated password from the migrate container's log), log in, and change it.

## Reverse proxy

The API trusts one proxy hop (`trust proxy = 1`) for client IPs and secure
cookies. Example Caddyfile:

```
api.lms.example.org {
  reverse_proxy 127.0.0.1:3000
  request_body { max_size 60MB }
}
```

## Health and monitoring

- `GET /health` → `200 {"status":"ok"}` when database and storage respond,
  `503` otherwise. The Docker image has a built-in `HEALTHCHECK`.
- Logs are JSON on stdout; ship them to your log platform. Every line about a
  failed request includes its `requestId`, which clients receive in
  `X-Request-Id` and in error bodies.
- Watch `GET /api/v1/admin/reports/overview` → `actionRequired.failedEmails`.

## Backups

- Database: rely on the managed provider's PITR; also test a restore regularly.
- Files: enable versioning on the bucket.

## Data protection

Most users are minors. The platform follows data-minimisation defaults:
students see only first name + last initial of others, contact details are
visible to admins only, and every report export is audited. Confirm hosting
location and retention with Rwanda's personal data protection law
(Law N° 058/2021) before go-live.

## Scaling notes

- Background workers (e-mail outbox, reminders, cleanup) run in every API
  instance and coordinate through the database. To dedicate one instance to
  workers, set `WORKERS_ENABLED=false` on the others.
- `DATABASE_POOL_MAX` (default 10) × instances must stay below the database's
  connection limit.
