# ROF LMS — Testing

## Running the tests

| Command | What | Needs |
|---|---|---|
| `npm test` | Unit tests (`src/**/*.spec.ts`) | nothing |
| `npm run test:e2e` | End-to-end tests (`test/*.e2e-spec.ts`): the real application over HTTP against a real PostgreSQL | `TEST_DATABASE_URL` |
| `npm run test:routes` | Lists API routes no e2e test calls (exit 1 if any) | `npm run docs:api` first |
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

In the e2e environment (`test/setup-env.ts`), e-mail runs in dry-run mode,
uploads go to a temporary folder, rate limiting is off, and background jobs
are off. Tests call the workers directly when they need them (e-mail outbox,
reminders).

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
4. e2e tests;
5. build the application and the Docker image.

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
