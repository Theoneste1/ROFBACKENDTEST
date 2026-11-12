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

`GET /api/v1` is public. It returns the original `name`, `version`, `docs` and
`health` fields unchanged. Backends that support it also return `capabilities`:

```json
{
  "name": "ROF LMS API", "version": "1.0.0", "docs": "/api/docs", "health": "/health",
  "capabilities": {
    "schemaVersion": 1,
    "roles": ["STUDENT", "TEACHER", "MENTOR", "HEAD_COACH", "ADMIN", "SUPER_ADMIN"],
    "features": ["permissionScopes", "schoolAdministration", "schoolAffiliations",
                 "schoolDirectorySync", "schoolReferenceRequired"]
  }
}
```

- **No `capabilities` field:** the older backend. Use the legacy behaviour,
  for example an invitation may send `schoolName` for a new school. Never
  infer capabilities from `version` (it is `1.0.0` on both) or from failed requests.
- **`features`:** what the running backend supports right now, sorted. A
  feature that is not listed is not available. Unknown names are ignored.

| Feature | The frontend may rely on |
|---|---|
| `permissionScopes` | `GET /me/permissions` also returns `roleLabel`, `scopes.courseDivisions`, `scopes.programmes` and `overrides` |
| `schoolReferenceRequired` | Invitations and CSV imports name an **existing** school by `schoolId` or `schoolCode`. A name alone is refused (`SCHOOL_REFERENCE_REQUIRED`) and never creates a school. A name sent with a reference must match it (`SCHOOL_NAME_MISMATCH`). Creating and editing users also accepts `schoolCode` |
| `schoolAdministration` | `/admin/schools`: create, edit, activate/deactivate, import, contacts, offerings, history |
| `schoolAffiliations` | Students claim a school (`/me/school-affiliation`); staff review claims (`/admin/school-affiliations`) |
| `schoolDirectorySync` | `/admin/school-sync`: official-directory dry run, review, approval and apply |
| `teacherAccounts` | Listed only while the Teacher role is enabled: TEACHER accounts can be created and assigned |
| `headCoachAccounts` | Listed only while the Head Coach role is enabled: HEAD_COACH accounts can be created and assigned |

- **`roles`:** every value a user's `role` field may hold. The frontend must
  show each one safely, even where no account holds it yet.
- **`schemaVersion`:** adding a feature does not change it. Renaming or
  removing one, or changing what `roles` or `features` mean, raises it.

The definitions live in `src/app/capabilities.ts`. The response lists only
role and feature names, never configuration values or other internal details.

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
