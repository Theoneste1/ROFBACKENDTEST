# ROF LMS — Backend API

Backend for the **Rwanda Olympiad Foundation Learning Management System**: a
Mathematics LMS with two divisions (Junior S1–S3, Senior S4–S6) and four fixed
courses (Algebra, Geometry, Number Theory, Combinatorics).

- NestJS 12 · TypeScript 6 · PostgreSQL · Prisma 7
- REST API under `/api/v1`, OpenAPI docs at `/api/docs`
- JWT access tokens + rotating refresh tokens
- Local-disk or S3-compatible file storage
- In-app notifications and e-mail via a background outbox

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design,
[docs/DATABASE.md](docs/DATABASE.md) for the data model (ERD, policies,
migrations and seeding) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for
running it in production.

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
| http://localhost:8025 | Mailpit — every e-mail the API sends |
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
| Live sessions | View (own division) | Schedule (assigned scopes) | All |
| Analytics / reports | — | Course analytics (own scopes) | Everything + CSV exports |
| Accounts & settings | Own profile | Own profile | Users, divisions, mentor assignments, settings |

### The assignment workflow

```
Mentor prepares ─► Admin publishes ─► Students submit ─► Admin distributes
     ─► Mentor reviews & scores ─► Mentor returns review ─► Admin approves
     ─► Admin publishes results ─► Student sees score + feedback
```

Key endpoints, in order:

1. `POST /assignments` → `PATCH /assignments/:id/submit` (mentor)
2. `PATCH /assignments/:id/publish` (admin)
3. `POST /submissions` (student, multipart with `file`)
4. `POST /assignments/:id/distribute` (admin)
5. `PATCH /submissions/:id/start-review` → `PATCH /submissions/:id/mark` (mentor)
6. `PATCH /submissions/:id/submit-to-admin` (mentor)
7. `PATCH /submissions/:id/approve` → `POST /assignments/:id/results/publish` (admin)
8. `GET /me/submissions`, `GET /submissions/:id` (student)

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
  discussions/ live-sessions/ notifications/ email/
  leaderboard/ analytics/ reports/ settings/ audit/ study-groups/
prisma/
  schema.prisma        data model
  migrations/          migration history (baseline 2026-11-03)
  migrations_archive/  retired pre-baseline history (reference only)
  seed.ts
test/                  end-to-end tests (real database)
```
