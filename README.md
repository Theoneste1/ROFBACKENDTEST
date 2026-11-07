# ROF LMS — Backend API

Backend for the **Rwanda Olympiad Foundation Learning Management System**: a
Mathematics LMS with two divisions (Junior S1–S3, Senior S4–S6) and four fixed
courses (Algebra, Geometry, Number Theory, Combinatorics).

- NestJS 12 · TypeScript 6 · PostgreSQL · Prisma 7
- REST API under `/api/v1`, OpenAPI docs at `/api/docs`
- JWT access tokens + rotating refresh tokens
- Local-disk or S3-compatible file storage
- In-app notifications and e-mail via a background outbox

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Backend architecture: modules, authorization layers, state machines, files, notifications, reports, settings and audit, errors, testing, decisions |
| [docs/WORKFLOWS.md](docs/WORKFLOWS.md) | Business workflows step by step, with the endpoints for each step |
| [docs/DATABASE.md](docs/DATABASE.md) | Database schema, ERDs, integrity rules, deletion/retention policy, migration history, seeding |
| [docs/API.md](docs/API.md) | Endpoint reference (generated) |
| [docs/api/openapi.json](docs/api/openapi.json) | OpenAPI 3 specification (generated); live Swagger UI at `/api/docs` |
| [docs/api/ROF-LMS.postman_collection.json](docs/api/ROF-LMS.postman_collection.json) | Postman collection (generated): set `username`/`password`, run *Auth → POST /auth/login*, then any request |
| [docs/AUTHORIZATION.md](docs/AUTHORIZATION.md) | Authorization matrix: every endpoint × role (generated from the guards' metadata) |
| [docs/STORAGE.md](docs/STORAGE.md) | File storage: types and limits, upload pipeline, download rules, drivers, cleanup |
| [docs/TESTING.md](docs/TESTING.md) | Running the tests, what each suite covers, the security suite, smoke testing, CI |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Production deployment: configuration, database, auth, storage, proxy, releases and migrations, backup and recovery, monitoring, go-live checklist |
| [docs/EMAIL.md](docs/EMAIL.md) | E-mail through Resend: architecture, domain and DNS set-up, environment variables, safe local testing, troubleshooting |
| [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md) | Functionality summary, test results, known limitations, outstanding issues, frontend-integration checklist |
| [.env.example](.env.example) · [.env.production.example](.env.production.example) | Every environment variable, with defaults and notes · production template |

The generated documents come from the compiled code: run `npm run docs:api`
after changing endpoints (CI fails when they are out of date).

---

## Quick start

### Option A — Docker (everything included)

```bash
docker compose up -d --build
```

| URL | What |
|---|---|
| http://localhost:3000/api/docs | Swagger UI |
| http://localhost:3000/health | Health check |
| http://localhost:9001 | MinIO console (`rof` / `rof-minio-secret`) |

Log in as `admin` / `Admin12345`. Demo accounts (password `Demo1234`):
`mentor.junior`, `mentor.senior`, `student.s2`, `student.s5`.

### Option B — Node only (no Docker)

Requires Node.js 24+.

```bash
npm install
cp .env.example .env            # set JWT_SECRET (32+ chars) and DATABASE_URL

# No PostgreSQL installed? Prisma ships a local one:
npx prisma dev --name rof       # prints a DATABASE_URL; also set DATABASE_POOL_MAX=1

npx prisma generate
npm run db:migrate              # apply migrations
SEED_DEMO=true npm run db:seed  # divisions, courses, admin (+ demo users)
npm run start:dev
```

The seed prints the generated admin password once (or uses `SEED_ADMIN_PASSWORD`).

---

## Scripts

| Command | Purpose |
|---|---|
| `npm run start:dev` | Run with reload |
| `npm run build` / `npm run start:prod` | Compile / run compiled |
| `npm test` | Unit tests (no database) |
| `npm run test:e2e` | End-to-end tests — needs `TEST_DATABASE_URL` (**truncated on every run**) |
| `npm run test:cov` | Unit test coverage |
| `npm run test:routes` | Fail if any API route has no e2e test |
| `npm run docs:api` | Regenerate OpenAPI, Postman collection, API reference and authorization matrix |
| `npm run docs:responses` | Re-record response schemas from the e2e run (then `npm run docs:api`) |
| `npm run test:coverage:all` | Combined unit + e2e coverage, with the least-covered files |
| `npm run lint` / `npm run typecheck` | Static checks |
| `npm run db:migrate` | Apply migrations (production-safe) |
| `npm run db:migrate:dev` | Create a new migration after editing `schema.prisma` |
| `npm run db:seed` | Idempotent seed |

---

## Roles at a glance

| | Student | Mentor | Admin |
|---|---|---|---|
| Courses & resources | Read (own division) | Manage in assigned course × division | Manage all; edit/publish the 4 courses |
| Assignments | View, submit, resubmit | **Prepare** (draft → submit for publication) | **Publish** / reject / unpublish |
| Submissions | Own only | **Review, score, feedback** (assigned to them) | Distribute, approve/return, **publish results** — never grade |
| Discussions (threads) | Own division; report content | Assigned scopes | Moderate reports; lock/hide/archive |
| Academic years | Own enrolment history | — | Plan, activate (promotes students), enrolments |
| Analytics / reports | — | Course analytics (own scopes) | Dashboard, user and academic reports (filters, CSV exports) |
| Accounts & settings | Own profile | Own profile | Create / invite / CSV-import users, activate, suspend, reset passwords; divisions, mentor assignments, settings |

### The assignment workflow

```
Mentor prepares ─► Admin publishes ─► Students submit ─► Admin distributes
     ─► Mentor reviews & scores ─► Mentor returns review ─► Admin approves
     ─► Admin publishes results ─► Student sees score + feedback
```

Key endpoints, in order:

1. `POST /assignments` → `PATCH /assignments/:id/submit` (mentor)
2. `PATCH /assignments/:id/publish` (admin)
3. `POST /submissions` (student, multipart: `answerText` and/or `files`)
4. `POST /assignments/:id/distribute` or `PATCH /submissions/:id/assign` (admin)
5. `PATCH /submissions/:id/start-review` → `PATCH /submissions/:id/mark` (mentor)
6. `PATCH /submissions/:id/submit-to-admin` (mentor)
7. `PATCH /submissions/:id/approve` → `POST /assignments/:id/results/publish` (admin)
8. `GET /me/results`, `GET /me/results/:submissionId` (student: score, mentor feedback, feedback files)

Corrections after publication: `PATCH /submissions/:id/reopen` (admin) sends the
result back to the mentor and removes its points; the admin never edits scores.

---

## API conventions

- Base path `/api/v1`; `Authorization: Bearer <access_token>`.
- Lists accept `?page=&limit=` (max 100) and return `{ data, meta: { total, page, limit, totalPages } }`.
- Uploads are `multipart/form-data`; the file type is detected from content.
- Every error has the same shape — branch on `code`, not on `message`:

```json
{ "statusCode": 409, "error": "Conflict", "code": "INVALID_STATE_TRANSITION",
  "message": "…", "details": {…}, "requestId": "…", "path": "…", "timestamp": "…" }
```

---

## Security in brief

- **Sign-in and tokens:**
  - every route needs a valid token unless explicitly public;
  - access tokens last 15 minutes; refresh tokens rotate, with reuse detection;
  - password change, suspension, role change or "sign out everywhere" ends
    every session at once.
- **Roles and scope:** roles are checked on every route, and records are
  scoped:
  - students get only their own work and their division's published content;
  - mentors get only their assigned scopes and the submissions assigned to
    them;
  - administrators can't grade.
- **Login protection:**
  - per-IP rate limits on credential endpoints;
  - a per-account lockout after 5 wrong passwords;
  - responses never reveal whether an account exists.
- **Files:**
  - the type is detected from the file's content, never trusted from its name;
  - stored under random keys and served only through endpoints that check
    access, with `nosniff` and a sandboxing CSP;
  - request size is capped.
- **Input and database:**
  - unknown fields are rejected;
  - all SQL is parameterised;
  - CSV exports guard against formula injection.
- **Audit:** an append-only audit trail; the database itself rejects changes
  to it.

`test/security.e2e-spec.ts` checks all of this, including every route
against every role.

---

## Project layout

```
src/
  app/                 root module, health check
  config/              environment validation
  common/              access scoping, errors & filter, pagination, storage, decorators
  auth/                login, tokens, guards, password reset
  users/ divisions/ mentor-assignments/ schools/ mentor-requests/
  courses/             the 4 courses + resources + progress
  assignments/ submissions/
  discussions/ notifications/ email/
  leaderboard/ analytics/ reports/ settings/ audit/ study-groups/ (switched off)
prisma/
  schema.prisma        data model
  migrations/          migration history (baseline 2026-11-03)
  migrations_archive/  retired pre-baseline history (reference only)
  seed.ts
test/                  end-to-end tests (real database)
```
