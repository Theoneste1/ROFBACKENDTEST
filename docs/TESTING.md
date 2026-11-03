# ROF LMS — Testing

## Running the tests

| Command | What | Needs |
|---|---|---|
| `npm test` | Unit tests (`src/**/*.spec.ts`) | nothing |
| `npm run test:e2e` | End-to-end tests (`test/*.e2e-spec.ts`): the real application over HTTP against a real PostgreSQL | `TEST_DATABASE_URL` |
| `npm run test:routes` | Lists API routes no e2e test calls (exit 1 if any) | `npm run docs:api` first |
| `npm run test:coverage:all` | Runs both suites with coverage and prints the **combined** figures and least-covered files | `TEST_DATABASE_URL` |
| `npm run docs:responses` | Runs the e2e suite recording every JSON response's schema into `docs/api/response-schemas.json` (then run `npm run docs:api`) | `TEST_DATABASE_URL` |
| `npm run lint` · `npm run typecheck` | Static checks | — |

**The e2e database is wiped.** Every e2e file truncates every table before it
starts. `TEST_DATABASE_URL` must point to a disposable database, and the suite
refuses to run if it equals `DATABASE_URL`. Locally:

```bash
npx prisma dev --name rof-test --port 51300 --db-port 51301 --shadow-db-port 51302
# put the printed URL in .env as TEST_DATABASE_URL, then once:
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
npm run test:e2e
```

In the e2e environment (`test/setup-env.ts`), e-mail runs in dry-run mode
(except in `email-delivery`), uploads go to a temporary folder, rate limiting
is off, and background jobs are off. Tests call the workers directly when
they need them (e-mail outbox, reminders).

**Waiting for background work.** Notifications and e-mails are produced by
event handlers that run after the response is sent. `waitForEvents()` (in
`test/helpers.ts`) waits for exactly those handlers to finish, by tracking the
promises of Nest's event-handler wrapper, instead of sleeping. The only fixed
waits left are 1.1 s pauses in the session tests. Those are deterministic:
tokens record their issue time in whole seconds.

**Configuration in a test file.** The app reads its configuration when the
app module is imported. A test that needs different settings (SMTP, S3) sets
them in `vi.hoisted(...)`, which runs before the imports.

## What is covered

Every one of the API routes is called by at least one e2e test, checked by
`npm run test:routes`.

| Suite | Covers |
|---|---|
| `workflow` | The full journey: mentor drafts → admin publishes → student submits → admin distributes → mentor reviews → admin approves → admin publishes → student views result and feedback; leaderboard points |
| `auth`, `user-management` | Login, refresh rotation, logout, password reset, activation, invitations, CSV import, registration, mentor applications, suspension |
| `access` | Role and scope boundaries across modules |
| `courses` | Courses, resources, metadata, filters, discussions switch |
| `assignments` | Lifecycle, CLOSED/reopen, history, filters |
| `submissions`, `review`, `results` | Answers and files, resubmissions (student and mentor-requested), distribution, review cycles, admin approval, publication, result history, corrections |
| `discussions` | Course and assignment threads, permissions, reports, moderation, notifications |
| `live-sessions`, `notifications`, `notification-settings` | Scheduling rules, time zones, reminders, inbox API, per-type switches |
| `dashboard-reports` | Exact statistics against a known dataset, filters, CSV exports, authorization |
| `settings-audit` | Settings validation and effect, public support info, audit coverage, append-only audit trail |
| `remaining-endpoints` | Attachments, recall/unpublish, resource restore, feedback files, divisions, schools, leaderboard, e-mail jobs |
| `security` | See below |
| `email-delivery` | Real SMTP: an in-process SMTP server receives the e-mails. Password-reset link works; every bulk recipient mode; temporary failures retried, given up after 5 attempts, administrator retry; nothing sent twice |
| `s3-storage` | Real S3 API: upload, byte-for-byte download, access rules, health check, orphan clean-up deleting objects. **Needs `S3_TEST_ENDPOINT`** (+ `S3_TEST_ACCESS_KEY`, `S3_TEST_SECRET_KEY`); skipped with that reason otherwise. CI runs it against MinIO |
| `features`, `app` | Notifications, e-mail outbox, admin tools, health, errors |

### Security suite (`test/security.e2e-spec.ts`)

- **Role matrix on every route:** reads the same `@Roles` / `@Public` metadata
  the guards use, and calls every non-public route anonymously (expects 401)
  and as each role it doesn't allow (expects 403). New routes are covered
  automatically.
- **Authentication:**
  - forged, unsigned (`alg: none`), wrong-secret and expired tokens are rejected;
  - logout and "sign out everywhere" work;
  - password change and suspension end sessions;
  - the account lockout works and reveals nothing;
  - password-reset requests don't reveal whether an account exists, and only
    the newest reset link works;
  - one-time links are not kept in the e-mail outbox after sending.
- **Isolation:**
  - students can't reach other students' submissions, files, history or
    results;
  - only the assigned mentor can open a submission;
  - archived drafts stay hidden from students;
  - notifications are private.
- **Uploads:**
  - the type comes from the file's content, so an executable renamed `.pdf`
    is refused and HTML is never served as HTML;
  - path and header injection through file names doesn't work;
  - oversized requests are refused early.
- **Input:**
  - unknown fields are refused, so there's no mass assignment;
  - bad ids, paging limits and long text are rejected;
  - SQL-injection payloads in search and filter parameters are treated as
    plain text.
- **Exposure:**
  - no password or token hashes in any response;
  - students never see other users' e-mail addresses;
  - errors carry no stack traces or database details.
- **HTTP:** security headers are sent, `X-Powered-By` is absent, and unknown
  origins get no CORS access.

## Coverage

Each suite alone under-reports, so measure them together with
`npm run test:coverage:all`. On 2026-11-03 the combined figures were 92.7% of
lines and 80.4% of branches. The least-covered files are:
- dead code that is never loaded (`src/common/file.utils.ts`, the switched-off
  `src/study-groups/`);
- `main.ts`, the server bootstrap;
- the S3 driver when no S3 endpoint is configured.

## Load baseline

A built app with 20 concurrent clients for 10 seconds per endpoint, run on
2026-11-03 against the local PGlite database:

| Endpoint | 1 client p50 / p99 | 20 clients req/s · p50 · p99 | Errors |
|---|---|---|---|
| `GET /health` | — | 361 · 53 ms · 127 ms | 0 |
| `GET /courses` (student) | 7 / 17 ms | 117 · 168 ms · 231 ms | 0 |
| `GET /notifications` (student) | 9 / 21 ms | 35 · 519 ms · 1276 ms | 0 |
| `GET /me/assignments` (student) | 26 / 50 ms | 16 · 1205 ms · 1462 ms | 0 |
| `GET /admin/dashboard` | 65 / 167 ms | 8 · 1603 ms · 3731 ms | 0 |

The local PGlite database allows **one** connection, so concurrent requests
queue on it: the 20-client figures are a lower bound. The 1-client figures
show the actual work per request. Repeat on staging, against managed
PostgreSQL with `DATABASE_POOL_MAX=10`, before go-live.

## Live smoke test

The e2e harness turns background jobs off. Before a release, also run the
built app with workers on, against a disposable database:

1. Seed it with demo users: `SEED_DEMO=true npm run db:seed`.
2. Start the app: `WORKERS_ENABLED=true node dist/main`.
3. Drive a workflow over HTTP.
4. Check that the scheduled jobs fire: deadline reminders every 10 minutes,
   live-session reminders every 5 minutes, and the e-mail outbox every 10
   seconds.

## Continuous integration

`.github/workflows/ci.yml` runs these steps:

1. lint and typecheck;
2. unit tests;
3. migrate an empty database, then check the schema for drift;
4. start a MinIO container;
5. e2e tests, including real SMTP and S3;
6. build;
7. check the generated API docs are up to date, and that every route is tested;
8. build the Docker image.

A second job, `compose-smoke`, then:

1. brings up the whole `docker-compose` stack (Postgres, MinIO, Mailpit, the
   migrate step and the API);
2. checks `/health`, logs in, opens the dashboard and fetches the OpenAPI
   document.

## Writing tests

- Unit tests mock Prisma and test rules in isolation, for example
  `src/submissions/submissions.service.spec.ts`.
- E2e tests use `createTestApp()` and `login()` from `test/helpers.ts`. The
  seeded data has:
  - an admin;
  - two Junior Algebra mentors and one Senior Algebra mentor;
  - two Junior students and one Senior student;
  - the four courses and the current academic year.
- Assert error `code`s, not messages.
- Every new route should be added to a suite. `npm run test:routes` will
  report it otherwise.
