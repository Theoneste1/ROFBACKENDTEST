# Backend finalization report (2026-11-07)

Repository `ROFBACKENDTEST` · production `https://rofbackendtest.onrender.com` (Render, Ohio) ·
Neon PostgreSQL (us-east-2) · Cloudflare R2 bucket `rof-files` · Resend (`rwandaolympiadfoundation.org`, verified).
How it works with the frontend: [INTEGRATION.md](INTEGRATION.md).

Statuses: Completed and tested · Completed but not fully tested · Failed and fixed · Partially completed · Not completed · Requires owner action.

## Production

| Area | Result | Status |
|---|---|---|
| Availability | `/health` 200: database up, storage up | Completed and tested |
| Database | 17/17 migrations applied, no schema drift; active academic year 2026-2027 | Completed and tested |
| E-mail | Resend only (`RESEND_API_KEY`, exact spelling); `EMAIL_FROM` fixed after a `422 Invalid from` failure; approved reset e-mail delivered, link on `https://roflms.netlify.app` | Failed and fixed |
| CORS | `https://roflms.netlify.app` allowed with credentials | Completed and tested |
| R2 storage | Health timing consistent with a live R2 bucket check; region `WEUR` evidently accepted for that call (Cloudflare documents `auto`). Upload/download in production not performed: no production coach/admin credentials | Completed but not fully tested |
| SMTP | No code reads `SMTP_*` any more: the five Render variables can be removed | Requires owner action |
| Secrets in Git | None in 39 commits (keys, DB URLs, `.env` files, seeded passwords) | Completed and tested |

## Code and tests (local)

| Check | Result |
|---|---|
| Unit tests | 482 passed |
| End-to-end tests (real PostgreSQL) | 289 passed, 3 skipped (S3 — runs against S3Mock in CI) |
| Routes covered by e2e | 202/202 |
| Lint, type-check, build, API docs up to date | clean |
| CI (`main`, `5eec460`) | both jobs green |

Functional coverage (e2e + cross-app journeys): registration, login/logout, refresh rotation, password reset, activation (invitation and e-mail confirmation), user management, roles (403), courses and resources, assignments (draft → approval → publish), solution upload and resubmission, distribution/assignment to coaches, marking with feedback files, admin approval, result publication, notifications, CSV reports, uploads (type by content, size limits) and downloads.

Not part of the system (product decision): quizzes, online exams, automatic marking.

## Fixed in this phase

| Problem | Fix | Status |
|---|---|---|
| Quoted `EMAIL_FROM` from a hosting dashboard broke every e-mail | Quotes/spaces stripped; malformed sender refused at start-up (`cc27c8d`) | Failed and fixed |
| No way to tell which storage production uses (`/health` says "up" for both) | Start-up log names the bucket and endpoint host, or warns about local disk | Failed and fixed |
| Tests could send real e-mail when `.env` held a Resend key | Settings blanked in tests; mailer refuses the real API under `NODE_ENV=test` (`803c4d9`) | Failed and fixed |
| CSV export audit entry written after the file was sent | Awaited before sending (`e680903`) | Failed and fixed |
| CI: MinIO images withdrawn; smoke test counted paths | S3Mock; operations counted | Failed and fixed |

## Outstanding

- Frontend pages for academic years, bulk e-mail and the activity log (APIs exist).
- Health/log could also report the storage driver publicly; only the log does now.
- A production upload/download through R2 (needs an owner-run check, see below).
- Rotate the production admin password (it was handled in chat sessions).

## Deploying this repository

1. Push `feature/backend-completion` and open a pull request into `main` (CI runs on pull requests).
2. Merge when green — Render deploys `main` automatically.
3. Render → Logs: expect `E-mail delivery via Resend, from Rwanda Olympiad Foundation <info@…>` and `File storage: S3-compatible bucket "rof-files" at <account>.r2.cloudflarestorage.com`. A `File storage: LOCAL disk` warning means the R2 variables are not applied.
4. `/health` → database up, storage up.
5. Render → Environment: delete `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`. Recommended: `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`.
6. No database migration is pending.
