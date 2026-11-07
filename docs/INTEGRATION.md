# How the ROF LMS frontend and backend work together

Two independent repositories, deployed separately:

| | Repository | Hosting | Production address |
|---|---|---|---|
| Frontend (Next.js 16) | `ROFFRONTENDTEST` | Netlify | the Netlify site (e.g. `https://rof-lms.netlify.app`) |
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

## Verified (2026-11-07, both apps running locally, browser-equivalent requests)

39/39 journeys through the frontend proxy: public pages, error shapes, student
login → refresh cookie → silent refresh with rotation → logout, role
enforcement (403), coach upload → publish → student download byte-for-byte,
disguised executable refused, admin dashboard/reports/CSV. Direct cross-origin
upload of 12 MB with CORS preflight; foreign origins refused. Not yet verified
on the hosted sites (needs the Netlify deploy).
