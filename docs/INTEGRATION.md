# How the ROF LMS frontend and backend work together

Two independent repositories, deployed separately:

| | Repository | Hosting | Production address |
|---|---|---|---|
| Frontend (Next.js 16) | `ROFFRONTENDTEST` | Netlify | `https://roflms.netlify.app` |
| Backend (NestJS, Prisma) | `ROFBACKENDTEST` | Render (+ Neon PostgreSQL, Cloudflare R2, Resend) | `https://rofbackendtest.onrender.com` |

The same text is kept in both repositories (`INTEGRATION.md` in the frontend,
`docs/INTEGRATION.md` in the backend).

## Request paths

```
Browser ──(same origin)──► Netlify site /api/*  ──CDN proxy──► Render backend /api/v1/*
Browser ──(cross-origin, uploads only)──────────────────────► Render backend /api/v1/*
Backend ──► Resend (e-mail) · Neon (database) · R2 (files)
```

- **API calls** use `/api/v1/...` on the frontend's own origin. Netlify proxies
  them to the backend (`netlify.toml` `[[redirects]]`); locally the rewrite in
  `next.config.ts` does it (`API_PROXY_TARGET`). No CORS is involved.
- **File uploads** (multipart) go straight to the backend
  (`NEXT_PUBLIC_API_UPLOAD_ORIGIN`), because Netlify's proxy limits bodies to
  about 8 MB and the backend accepts up to 50 MB. They send the bearer token
  only (no cookies). The backend allows them through `CORS_ORIGINS`, and the
  frontend's CSP allows that one origin in `connect-src`.
- **Downloads** (`/file` endpoints, CSV exports) go through the proxy with the
  bearer token and are saved from a `blob:` URL.

## Authentication

- `POST /auth/login` returns a 15-minute **access token** (kept in memory by
  the frontend, sent as `Authorization: Bearer`) and sets the **refresh
  cookie** `rof_refresh`: httpOnly, `SameSite=Strict`, path `/api/v1/auth`,
  `Secure` in production. It works because the proxy keeps everything on one
  origin.
- On a 401 the frontend calls `POST /auth/refresh` once (single-flight across
  tabs) and retries; refresh tokens rotate on every use, and reuse revokes the
  session. `POST /auth/logout` ends it.
- Roles: `STUDENT`, `MENTOR` (shown as "Coach"), `ADMIN`. The backend enforces
  every permission (403 `FORBIDDEN`); the frontend only hides what a role
  cannot use (`GET /me/permissions`).

## Errors

Every backend error has one shape, which the frontend's `ApiError` reads:

```json
{ "statusCode": 400, "error": "Bad Request", "code": "VALIDATION_FAILED",
  "message": "Request validation failed.", "details": ["…"], "requestId": "…" }
```

## Backend capabilities (`GET /api/v1`)

`GET /api/v1` is public and sent with `Cache-Control: no-store`. It returns the
original `name`, `version`, `docs` and `health` fields unchanged. Backends that
support it also return `capabilities`:

```json
{
  "name": "ROF LMS API", "version": "1.0.0", "docs": "/api/docs", "health": "/health",
  "capabilities": {
    "schemaVersion": 1,
    "roles": ["STUDENT", "TEACHER", "MENTOR", "HEAD_COACH", "ADMIN", "SUPER_ADMIN"],
    "features": ["permissionScopes", "schoolAdministration", "schoolAffiliations",
                 "schoolReferenceRequired"]
  }
}
```

### Detecting the backend: LEGACY, NEW or UNKNOWN

Classify every `GET /api/v1` attempt as exactly one of three results.

| Result | All of these hold |
|---|---|
| **LEGACY** | HTTP status 200 · the body is valid JSON and a JSON object · `name === "ROF LMS API"` · `version`, `docs` and `health` are strings · there is **no** `capabilities` property |
| **NEW** | The LEGACY conditions for `name`, `version`, `docs` and `health` · `capabilities` is a JSON object · `capabilities.schemaVersion === 1` (an integer) · `capabilities.roles` is an array of strings · `capabilities.features` is an array of strings |
| **UNKNOWN** | Everything else |

UNKNOWN includes:
- network errors, timeouts and aborted requests (the free-plan backend can take
  about a minute to wake);
- any status other than 200, for example 304 handled by hand, 3xx, 404, 429
  (rate limit) and 5xx;
- HTML or any other non-JSON body, for example the Netlify 404 page;
- malformed JSON, or JSON that is not an object (an array, a string, `null`);
- a missing or wrongly typed `name`, `version`, `docs` or `health`, or a
  different `name`;
- `capabilities: null`, or a `capabilities` value that is not an object;
- a missing or non-integer `schemaVersion`, or any `schemaVersion` other than 1;
- `roles` or `features` that are missing, not arrays, or contain non-strings.

**UNKNOWN never falls back to LEGACY.** Retry, or show a clear "cannot reach the
server" state. Only a response that meets every LEGACY condition is legacy.
Never infer anything from `version`: it is `1.0.0` on both backends.

### What the capabilities mean

Capabilities describe **backend-wide functionality**. They are the same for
every viewer and say nothing about the current user's permissions or access. For
those, use `GET /me/permissions`, and the API still refuses anything not permitted.

- **`roles`:** every role a stored user account may hold (the database role
  values). It is **not** the list of roles that can currently be registered or
  assigned. The frontend must show each value safely (P1-F1), including
  `SUPER_ADMIN`, which the API never assigns.
- **`features`:** sorted names of what the backend supports right now. Check
  each one on its own with `features.includes(name)`; don't rely on order.
  A feature that is not listed is not available. Ignore names you don't know.

| Feature | When listed, the frontend may rely on |
|---|---|
| `permissionScopes` | `GET /me/permissions` also returns `roleLabel`, `scopes.courseDivisions`, `scopes.programmes` and `overrides` |
| `schoolReferenceRequired` | Invitations and CSV imports name an **existing** school by `schoolId` or `schoolCode`. A name alone is refused (`SCHOOL_REFERENCE_REQUIRED`) and never creates a school. A name sent with a reference must match it (`SCHOOL_NAME_MISMATCH`). Creating and editing users also accepts `schoolCode` |
| `schoolAdministration` | `/admin/schools`: create, edit, activate/deactivate, import, contacts, offerings, history |
| `schoolAffiliations` | Students claim a school (`/me/school-affiliation`); staff review claims (`/admin/school-affiliations`) |
| `teacherAccounts` | The `TEACHER` role can currently be **assigned** to an account (create, invite, import, role change). The caller also needs `users.manageTeachers` in `/me/permissions` |
| `headCoachAccounts` | The `HEAD_COACH` role can currently be **assigned** to an account. The caller also needs `users.manageHeadCoaches` in `/me/permissions` |

When `teacherAccounts` or `headCoachAccounts` is **absent**, the role can't be
newly assigned. Existing `TEACHER` or `HEAD_COACH` accounts may still exist and
use their portals. Show a portal by the signed-in user's `role`, never by these
features.

The official-directory sync (`/admin/school-sync`) is not advertised in
`schemaVersion` 1. Its routes are unchanged, but clients must not build on it
until it is approved for production.

- **`schemaVersion`:** adding a feature does not change it. Renaming or
  removing a feature, or changing what `roles` or a feature means, raises it.
  Clients treat any value other than 1 as UNKNOWN.

The definitions live in `src/app/capabilities.ts`. The frozen V1 feature list is
in `src/app/capabilities.spec.ts`. The response lists only role and feature
names, never configuration values or other internal details.

## E-mail links

The backend builds links from its `APP_URL` (the frontend's address):
`/reset-password?token=…`, `/activate?token=…`, `/login`, and deep links such
as `/assignments/:id`. The frontend serves each of these routes.

## Settings that must match

| Backend (Render) | Frontend (Netlify, `netlify.toml`) |
|---|---|
| `APP_URL` = the Netlify site address | — |
| `CORS_ORIGINS` = the Netlify site address (exact, no trailing slash) | `NEXT_PUBLIC_API_UPLOAD_ORIGIN` = backend address |
| service address `https://rofbackendtest.onrender.com` | `API_PROXY_TARGET` and the `/api/*` redirect target = backend address |

## Test results (2026-11-07)

**Local, both apps running, browser-equivalent requests through the frontend's `/api` proxy, uploads cross-origin as in production:**

- 39/39 general journeys: public pages, error shape, student login → refresh cookie (httpOnly, Strict, `/api/v1/auth`) → silent refresh with rotation → logout, 403 for other roles, coach upload → publish → student download byte-for-byte, disguised executable refused (`FILE_TYPE_NOT_ALLOWED`), admin dashboard/reports/CSV.
- 26/26 assessment workflow: coach drafts an assignment with a brief → admin publishes → student downloads the brief and uploads a solution (re-upload = revision 2) → admin assigns a coach → coach downloads the solution, marks 16/20 with written feedback and a feedback file (score above maximum refused) → admin approves and publishes → student sees score, percentage, feedback, downloads the feedback file; internal notes hidden; notifications and unread counter; students cannot mark, coaches cannot publish.
- 12 MB direct upload with CORS preflight; foreign origins refused.

**Production (read-only or approved):**

- Backend `/health`: database up, storage up; health is ~300 ms slower than a database-only call, consistent with a live R2 bucket check.
- CORS: `https://roflms.netlify.app` allowed, with credentials.
- E-mail: an approved password-reset e-mail to the admin was **delivered** by Resend from `Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>`; its link points to `https://roflms.netlify.app/reset-password?token=…`.
- **Frontend: `https://roflms.netlify.app` serves Netlify's "Page not found" on every path.** A clean build of frontend `main` stops with "API_PROXY_TARGET must be set…" (reproduced); the `feature/production-readiness` branch sets it in `netlify.toml` and builds cleanly from a fresh clone.

Not yet possible: browser tests on the live site (needs the fixed frontend deployed), and a live upload to R2 (needs a production coach or admin login).
