# Hosting ROF LMS for free

One small server runs PostgreSQL, the API and HTTPS. Uploaded files live in
Cloudflare R2, and e-mail goes through Resend. Every part
has a free tier; check each provider's current terms when you sign up.

| Part | Service | Free allowance (at time of writing) |
|---|---|---|
| Server (API + PostgreSQL + Caddy) | Oracle Cloud "Always Free" Ampere A1 VM | up to 4 ARM cores, 24 GB RAM, 200 GB disk; always on |
| Uploaded files + backups | Cloudflare R2 | 10 GB, no download fees |
| E-mail | Resend | 3,000 e-mails/month, 100/day |
| Uptime alerts | UptimeRobot or Better Stack | 1 check every 5 min |
| Frontend (later) | Cloudflare Pages, Netlify or Vercel | static sites |

Unlike free "web service" hosts, the VM never sleeps. That matters here: the
API sends e-mails from a background job that must keep running.

**What you take on:** the server is yours to look after. Security updates
install automatically, backups run nightly (step 7), and an uptime check
tells you if the server stops (step 8).

---

## 1. Create the accounts

1. **Oracle Cloud:** sign up at cloud.oracle.com. A card is asked for to
   verify identity; Always Free resources are not charged. The **home region
   can't be changed later**: choose one close to Rwanda that offers Ampere A1,
   for example Johannesburg or a European region.
2. **Cloudflare:** sign up and enable **R2** (it asks for a payment method;
   usage under the free allowance is not charged).
3. **E-mail:** sign up at resend.com, verify the domain and create an API key
   — see [docs/EMAIL.md](../../docs/EMAIL.md) §2–§4.

## 2. Create the server

In the Oracle console: **Compute → Instances → Create instance**.

- Image: **Ubuntu 24.04** (or 22.04). Shape: **Ampere A1 Flex**, 2 OCPU and
  12 GB RAM (leaves half the free allowance for a staging server later).
- Boot volume: 100 GB.
- Add your SSH public key.
- If the console says "out of capacity", try another availability domain or
  try again later; it's common for A1.

Then open the ports: the instance's **subnet → Security list → Add ingress
rules**, source `0.0.0.0/0`:
- TCP 80;
- TCP 443;
- UDP 443.

Note the instance's **public IP**. Prefer a reserved public IP
(**Networking → Reserved public IPs**) so the address survives a stop/start.

## 3. Create the storage buckets

In Cloudflare: **R2 → Create bucket**, twice, both private:
- `rof-files` (uploads);
- `rof-backups` (nightly backups).

Then **R2 → Manage API tokens → Create API token**:
- permission: **Object Read & Write**;
- buckets: only those two.

Keep the **Access Key ID**, **Secret Access Key** and the endpoint
`https://<account-id>.r2.cloudflarestorage.com`.

## 4. Point the domain at the server

Where the domain's DNS is managed, add:

| Type | Name | Value |
|---|---|---|
| A | `api.lms` | the server's public IP |

Also add the DKIM, SPF and MX records Resend gave you (docs/EMAIL.md §3).

If the DNS is on Cloudflare, set the record to **DNS only** (grey cloud).
With the orange cloud on, set `TRUST_PROXY=2` in `.env`.

The frontend will later live at `lms.<your-domain>`. The API and the frontend
must share the same site: the sign-in cookie is `SameSite=Strict`.

## 5. Install and start

```bash
ssh ubuntu@<server-ip>

sudo git clone https://github.com/Theoneste1/ROFBACKENDTEST.git /opt/rof
#   private repository: use a GitHub personal access token (read-only) as the password
sudo chown -R "$USER" /opt/rof
cd /opt/rof

bash deploy/free-tier/setup-server.sh
#   copy the backup passphrase it prints into your password manager
exit                                   # log out and in again (docker group)

ssh ubuntu@<server-ip>
cd /opt/rof/deploy/free-tier
cp .env.example .env
openssl rand -hex 24                   # → POSTGRES_PASSWORD
openssl rand -base64 48                # → JWT_SECRET
nano .env                              # fill in every <…>
chmod 600 .env

docker compose up -d --build           # first build: about 5–10 minutes
docker compose logs -f migrate api     # Ctrl+C when "Nest application successfully started"
```

Check it, from anywhere:

```bash
curl https://api.lms.<your-domain>/health
# {"status":"ok","checks":{"database":"up","storage":"up"},…}
```

If the certificate isn't issued, check the DNS record (step 4) and the ports
(step 2): `docker compose logs caddy`.

## 6. First sign-in and settings

1. Sign in as `admin` with `SEED_ADMIN_PASSWORD`, then change the password
   (`PATCH /api/v1/auth/password`).
2. Remove `SEED_ADMIN_PASSWORD` from `.env` and run `docker compose up -d`.
3. Check the academic year (`GET /api/v1/academic-years/current`).
4. Set the platform name and support contacts (`/api/v1/admin/settings`).
5. Invite yourself as a mentor to check that e-mail arrives.
6. Upload and download one file to check storage.

Until the frontend exists, use Postman
(`docs/api/ROF-LMS.postman_collection.json`, with `baseUrl` set to
`https://api.lms.<your-domain>/api/v1`).

## 7. Backups

`setup-server.sh` installed a nightly job (03:30 Kigali time). It:
- saves an encrypted database dump to the server (7 days) and to the
  `rof-backups` bucket (30 days);
- copies every uploaded file into `rof-backups/files`.

Run it once now to check it works:

```bash
sudo bash /opt/rof/deploy/free-tier/backup.sh
sudo tail /var/log/rof-backup.log      # later runs log here
```

**Keep `/etc/rof/backup-passphrase` in a password manager.** Without it the
backups can't be decrypted.

**Restore drill** (once a term; it doesn't touch the live database):

```bash
cd /opt/rof/deploy/free-tier
sudo gpg --batch --pinentry-mode loopback --passphrase-file /etc/rof/backup-passphrase \
  -d /var/backups/rof/rof-<date>.dump.gpg > /tmp/rof.dump
docker compose exec -T postgres createdb -U rof rof_restore
docker compose exec -T postgres pg_restore -U rof -d rof_restore --no-owner --no-privileges < /tmp/rof.dump
docker compose exec -T postgres psql -U rof -d rof_restore -c 'select count(*) from "User";'
docker compose exec -T postgres dropdb -U rof rof_restore && rm /tmp/rof.dump
```

## 8. Monitoring

Create a free monitor (UptimeRobot or Better Stack) on
`https://api.lms.<your-domain>/health`, alerting by e-mail. It answers 503 if
the database or storage is down.

Useful commands on the server:

```bash
docker compose ps                      # all services "running"/"healthy"
docker compose logs --since 1h api     # API errors (JSON lines)
docker compose exec caddy tail /var/log/caddy/rof-api.log   # every request
df -h /                                # disk space
```

## 9. Releasing a new version

```bash
cd /opt/rof
sudo bash deploy/free-tier/backup.sh   # 1. back up first
git pull                               # 2. new code
cd deploy/free-tier
docker compose up -d --build           # 3. migrate, then restart the API
curl https://api.lms.<your-domain>/health
```

Migrations only add tables, columns and indexes, so the old version keeps
working if you need to go back: `git checkout <previous-commit>` and
`docker compose up -d --build`. See `docs/DEPLOYMENT.md` §8 if a migration
fails.

## When to move beyond free

- More than a few hundred active students, or a need for a guaranteed uptime
  and support → managed PostgreSQL and hosting. Nonprofit credits (Google,
  Microsoft, AWS via TechSoup) may cover it.
- R2 over 10 GB, or Resend over 100 e-mails/day → the paid tiers are small.

The application needs no change to move: point `DATABASE_URL` at a managed
database (restore a backup into it) and run the same Docker image elsewhere.
`docs/DEPLOYMENT.md` covers the general production setup.
