# Hosting ROF LMS for free on Render

| Part | Service | Free plan |
|---|---|---|
| API | Render web service (Docker, Frankfurt), from [`render.yaml`](../../render.yaml) | sleeps after ~15 idle minutes, wakes on the next request (about a minute) |
| Database | Neon PostgreSQL (Frankfurt) | 0.5 GB; sleeps when idle, wakes by itself |
| Uploaded files | Cloudflare R2 | 10 GB |
| E-mail | Brevo, or Google Workspace | Brevo about 300 e-mails/day |

There are no automatic reminders, so the API sleeping only means a slower
first request. E-mails are sent from a queue within seconds of the action that triggers them.

Never put connection strings, keys or passwords in git or in chat. They go
in `.env.production.local` on your computer (git-ignored) and in Render's
dashboard.

## 1. Database (Neon)

1. Sign up at neon.tech. Create a project `rof-lms`, region **AWS Europe
   Central 1 (Frankfurt)**.
2. **Connect** → turn **Connection pooling off** → copy the connection string.
3. In the repository folder, create `.env.production.local`:

   ```
   DATABASE_URL="postgresql://…neon.tech/neondb?sslmode=require"
   SEED_ADMIN_USERNAME=admin
   SEED_ADMIN_EMAIL=you@your-domain
   SEED_ADMIN_PASSWORD=<a strong password you choose>
   ```

4. Create the tables and the first administrator (Git Bash, in the repository):

   ```bash
   set -a; . ./.env.production.local; set +a
   NODE_ENV=production npx prisma migrate deploy
   NODE_ENV=production npx prisma db seed
   ```

   Then delete the `SEED_ADMIN_PASSWORD` line from the file.

**Every release that adds a migration:** run `npx prisma migrate deploy` the
same way **before** Render deploys the new code.

## 2. File storage (Cloudflare R2)

1. Cloudflare dashboard → **R2** → enable it (asks for a card; the free
   allowance isn't charged).
2. **Create bucket** `rof-files` (private).
3. **Manage API tokens → Create API token**: *Object Read & Write*, only
   bucket `rof-files`. Keep the Access Key ID, the Secret Access Key and the
   S3 endpoint `https://<account-id>.r2.cloudflarestorage.com`.

## 3. E-mail

- **Brevo:** sign up; **Senders & domains** → add and verify your domain
  (add the SPF/DKIM DNS records it shows); **SMTP & API** → create an SMTP
  key. Host `smtp-relay.brevo.com`, user = the SMTP login shown there.
- **Google Workspace:** a sending mailbox with 2-step verification and an
  **app password**. Host `smtp.gmail.com`, user = the mailbox address.

## 4. API (Render)

1. Sign up at render.com with GitHub and allow it to read this repository.
2. **New → Blueprint** → choose the repository. Render reads `render.yaml`.
3. Fill in the values it asks for:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon string from step 1 |
   | `CORS_ORIGINS`, `APP_URL` | the frontend's address; until it exists, `http://localhost:5173` |
   | `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | from step 2 |
   | `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` | from step 3 |
   | `EMAIL_FROM` | `ROF Learning <noreply@your-domain>` |

4. **Apply.** The first build takes about 5–10 minutes.
5. Check `https://rof-lms-api.onrender.com/health` (your exact address is
   shown in Render): `"database":"up","storage":"up"`.

## 5. After the first deploy

1. Sign in as the administrator (Postman: `docs/api/ROF-LMS.postman_collection.json`,
   `baseUrl` = `https://<your-service>.onrender.com/api/v1`) and change the
   password (`PATCH /auth/password`).
2. `PATCH /admin/settings` with `{ "notifications.emailEnabled": false }` if
   you want no e-mail copies of notifications (account e-mails still go out).
3. Set the platform name and support contacts in the same settings.
4. Invite yourself as a mentor to check that e-mail arrives; upload a file
   to check storage.

## Your own domain (when the frontend goes live)

The sign-in cookie is `SameSite=Strict`: the frontend and the API must be on
the same site. Add a custom domain in Render (e.g. `api.lms.<your-domain>`)
and host the frontend at `lms.<your-domain>`, then set `CORS_ORIGINS` and
`APP_URL` to `https://lms.<your-domain>`.
