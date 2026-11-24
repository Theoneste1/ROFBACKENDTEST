# E-mail (Resend)

The API sends all e-mail through [Resend](https://resend.com) as
**Rwanda Olympiad Foundation &lt;info@rwandaolympiadfoundation.org&gt;**, with
replies going to `info@rwandaolympiadfoundation.org` (a Google Workspace
mailbox).

## 1. How it works

```
 request (forgot password, invite, register, …)
        │  queueEmail() / notify()
        ▼
 EmailDelivery row (outbox, PostgreSQL): subject + plain text + branded HTML
        │  EmailWorker, every 10 s, FOR UPDATE SKIP LOCKED
        ▼
 MailerService ──► Resend API (official `resend` SDK)
        │
        ├─ accepted  → SENT, Resend id stored in messageId; one-time links erased
        ├─ temporary → retried after 1, 2, 4, 8 min; FAILED after 5 attempts
        └─ permanent → FAILED at once (e.g. invalid address)
```

- E-mails are never sent during a request, so a slow or failing provider
  never slows down or breaks login, registration or password reset.
- Each delivery's id is sent to Resend as an **idempotency key**, so a crash
  between sending and recording cannot send the same e-mail twice.
- The worker paces requests to `EMAIL_MAX_PER_SECOND` (Resend's default
  limit is 2 per second).
- Logs never contain message bodies, links or tokens; recipients are masked
  (`j***e@example.org`). Once a password-reset or activation e-mail is sent
  (or given up), its stored text and HTML are erased.

| File | Role |
|---|---|
| `src/email/mailer.service.ts` | Sends one e-mail through Resend; dry run, redirect, rate limit, error classification |
| `src/email/templates.ts` | Branded, responsive HTML and plain-text templates (all values escaped) |
| `src/email/email.worker.ts` | Drains the outbox, retries and backoff |
| `src/notifications/notifications.service.ts` | `queueEmail()` and `notify()`: compose and queue e-mails |
| `src/notifications/account-emails.service.ts` | Welcome, account approved, password changed |
| `src/auth/activation.service.ts`, `src/auth/auth.service.ts` | Activation, e-mail confirmation, password reset |
| `scripts/email-check.ts` | `npm run email:check`: checks the key and domain, sends a test e-mail |

### E-mails the platform sends

| E-mail | When | Link (APP_URL + …) | Valid |
|---|---|---|---|
| Reset your password | "Forgot password", or an administrator sends a reset link | `/reset-password?token=…` | 30 minutes, once |
| Activate your account | An administrator invites a user (or a CSV import) | `/activate?token=…` | 7 days, once |
| Confirm your e-mail address | Sign-up when e-mail activation is on for that form (student, teacher or coach; off by default) | `/activate?token=…` | 48 hours, once |
| Welcome | Account activated, or registered without e-mail confirmation | `/login` | — |
| Your account has been approved | An administrator approves a pending registration | `/login` | — |
| Your password was changed | After a password reset or change (security notice) | `/forgot-password` | — |
| Coach application declined | Administrator declines a coach application | — | — |
| Your coach / teacher application has been approved | Administrator approves (decision notification, also in-app); "ready to use" and the login link only when the account is already activated — otherwise it points to the separate confirmation e-mail | `/login` (activated only) | — |
| Your school is now part of the ROF Olympiad Community! | Administrator verifies a missing school: a teacher applicant's (e-mail only, to the application address) or a student's "not listed" claim (also in-app) | — | — |
| You have been given new permission(s) | A Teacher, Coach or Head Coach is granted permissions (each listed in plain language; also in-app) | `/login` (activated only) | — |
| Notifications | Assignments, results, … (users can turn categories off) | the related page | — |
| Bulk e-mail | Administrators, `POST /admin/email/send` | — | — |
| Contact form | To the support address in the platform settings | `/admin/messages` | — |

**Decision notifications** (`src/decision-notifications/`) are queued in the `NotificationOutbox`
table in the same transaction as the Administrator's action and sent right after it commits; a failed
send only marks the row `FAILED` (sanitised error, backoff 1, 2, 4, 8 … minutes, at most 5 automatic
attempts by the worker when `WORKERS_ENABLED` is not `false`, which also recovers rows stuck in
`SENDING` for 5 minutes). Each event has a `dedupeKey`, so a repeated action or delivery never sends
twice. Administrators see and retry them at `/admin/notification-deliveries` (`email.bulkSend`). They are
account-status notices (category `ACCOUNT`): like activation, approval and password e-mails they
cannot be switched off and ignore the per-category e-mail preferences and `notifications.emailEnabled`.

**Teacher-registration notices follow teacher self-registration** (owner decision 10): the notices about
a teacher application (the teacher approval, and "Your school is now part of …" for a teacher applicant's
missing school) are sent only while teacher self-registration is enabled — `TEACHERS_ENABLED=true` and the
`registration.teacherSelfSignup` setting on. While it is off an Administrator's decision still applies but
queues no notice (no outbox row, no in-app notification; the audit entry records
`NOT_SENT_SELF_REGISTRATION_OFF`), and a notice queued earlier is not e-mailed (it is marked `FAILED`,
"Not sent: teacher self-registration is turned off.", no automatic retry). Teacher rejections send no
notice at all. Coach approval, student school verification and permission grants are not
teacher-registration notices and are sent as before. The account confirmation e-mail of an approved
teacher (when e-mail confirmation is required) is an account e-mail, not a decision notice, and is still
sent so the account can be used.

Requesting a new reset or activation link makes the earlier one invalid.
Expired, used and unknown links are refused with `INVALID_RESET_TOKEN` /
`INVALID_ACTIVATION_TOKEN`.

The footer's contact address is the **support e-mail** platform setting
(Settings → Help and support). If that is empty, `EMAIL_REPLY_TO` is used.

## 2. Resend account and API key

1. Sign up at [resend.com](https://resend.com) with a foundation address.
2. Add and verify the domain first (§3).
3. **API Keys → Create API key**: name `rof-lms-production`, permission
   **Sending access**, domain `rwandaolympiadfoundation.org`. Copy the key
   (it starts with `re_` and is shown only once).
   - For `npm run email:check` to also show the domain's DNS status, use a
     separate **Full access** key on your own computer only.
4. Put the key **only** in:
   - your local `.env` (`RESEND_API_KEY=re_…`), which git ignores; and
   - Render → the service → **Environment** (production).

   Never paste it into source code, a committed file, a `NEXT_PUBLIC_…`
   variable, the frontend, or a chat. If it leaks, delete it in Resend and
   create a new one.

## 3. Domain verification (DNS at Namecheap)

The DNS for `rwandaolympiadfoundation.org` is hosted at **Namecheap**
(nameservers `dns1/dns2.registrar-servers.com`). Its mailboxes are on
**Google Workspace** (MX `aspmx.l.google.com`). Do not change the MX records
of the root domain.

1. Resend → **Domains → Add domain** → `rwandaolympiadfoundation.org`.
   Region: **North Virginia (us-east-1)**.
2. Resend shows the exact records to add. They are generated for your
   account, so copy them from the dashboard rather than from this guide.
   Usually these are:
   - **DKIM:** `TXT` record `resend._domainkey` with a long `p=…` value.
   - **SPF / return path:** on the `send` subdomain, either an `MX` record and
     a `TXT` record (`v=spf1 include:… ~all`), or one `CNAME` record when the
     domain uses Resend Forge.
3. Namecheap → **Domain List → Manage → Advanced DNS → Add new record**. For
   each record:
   - **Host:** only the part before the domain, e.g. `resend._domainkey` or
     `send`. Namecheap adds `.rwandaolympiadfoundation.org` itself.
   - **Value:** paste it exactly as shown.
   - **MX records** (only if Resend asks for one on `send`) go in the
     **Mail Settings** section, which is already on **Custom MX** for Google.
     Add the new row there and leave the Google MX rows unchanged.
   - **TTL:** Automatic.
4. Back in Resend, click **Verify DNS records**. This usually takes
   15 minutes, and at most 72 hours.

**Records for this domain** (generated by Resend on 2026-11-07, region
us-east-1, Resend Forge). They are all published at Namecheap:

| Type | Host | Value | Purpose |
|---|---|---|---|
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC4K247…QIDAQAB` (full value in the Resend dashboard) | DKIM signature |
| CNAME | `send` | `send.forge.rmta.net` | SPF / return path |
| CNAME | `rsend` | `rsend.forge.rmta.net` | SPF / return path |

Other records found on the domain:

| Record | Value | Action |
|---|---|---|
| `_dmarc` TXT | `v=DMARC1; p=none; rua=mailto:rua@dmarc.brevo.com` | Reports go to **Brevo**: change it (§4) |
| root TXT `brevo-code:…`, CNAME `brevo1/brevo2._domainkey` | Brevo | Remove when Brevo is no longer used (§4) |
| root SPF | none | See §4 |

## 4. DMARC and clean-up (recommended)

DMARC tells receiving servers what to do with mail that claims to come from
your domain but fails DKIM/SPF. Resend's e-mails pass DMARC through the
aligned DKIM signature (`resend._domainkey`).

1. **Point DMARC reports to the foundation, not Brevo.** In Namecheap, edit
   the existing `TXT` record with host `_dmarc` (keep only one `_dmarc`
   record):

   ```
   v=DMARC1; p=none; rua=mailto:info@rwandaolympiadfoundation.org
   ```

   A dedicated mailbox or group such as `dmarc@…` is better if you have one,
   because reports arrive daily.
2. Send e-mails for 2–4 weeks and check the reports, or the headers of
   received e-mails (`dmarc=pass`). Then tighten the policy to
   `p=quarantine`, and later `p=reject`. Keep the `rua=` part.
3. **Root SPF for Google Workspace.** The root domain has no SPF record. Mail
   sent by people from Gmail as `info@rwandaolympiadfoundation.org` should
   have one before you tighten DMARC. Add a `TXT` record with host `@`:
   `v=spf1 include:_spf.google.com ~all`. Also turn on DKIM in the Google
   Admin console (Apps → Gmail → Authenticate email). Resend does not need
   the root SPF, because it uses the `send` subdomain.
4. **Brevo leftovers.** When nothing else (for example a newsletter) uses
   Brevo, delete the `brevo-code` TXT and the `brevo1/brevo2._domainkey`
   CNAME records.

## 5. Environment variables

| Variable | Local development | Production (Render) |
|---|---|---|
| `RESEND_API_KEY` | Empty = dry run (logged only); or your key | **Required** (secret) |
| `EMAIL_FROM` | `Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>` | **Required**, same value (set in `render.yaml`) |
| `EMAIL_REPLY_TO` | `info@rwandaolympiadfoundation.org` | same (set in `render.yaml`) |
| `EMAIL_REDIRECT_TO` | **Your own inbox**, whenever a real key is set | **Unset** |
| `EMAIL_DRY_RUN` | Unset | **Unset** in production. `true` only on a **staging** service (copy of real data): nothing is sent even with a key, no key or sender needed; warned at every start |
| `APP_URL` | `http://localhost:3001` | **Required**: the public frontend URL, no trailing slash |
| `API_PUBLIC_URL` | Unset | Optional: the API's public https address (no `/api/v1`). When set, e-mails to news subscribers offer one-click unsubscribe (RFC 8058); see `docs/SUBSCRIBERS.md` |
| `EMAIL_MAX_PER_SECOND` | 2 | 2 (raise only if Resend raised your limit) |
| `EMAIL_BATCH_SIZE` | 50 | 50 |
| `EMAIL_DAILY_LIMIT` | 100 | 100 (Resend Free plan, §10). `0` = no daily limit (Resend Pro) |
| `EMAIL_MONTHLY_LIMIT` | 3000 | 3000 (Resend Free plan, §10). Pro: `50000`. `0` = no monthly limit |
| `EMAIL_DAILY_SAFETY_MARGIN` | 5 | 5 → at most **95** e-mails per UTC day |
| `EMAIL_MONTHLY_SAFETY_MARGIN` | 100 | 100 → at most **2,900** e-mails in any 31 days |
| `EMAIL_NORMAL_SHARE_PERCENT` | 80 | 80 → ordinary e-mails stop at 76 a day; the rest is kept for urgent ones |
| `EMAIL_BULK_SHARE_PERCENT` | 50 | 50 → bulk e-mails and mailings stop at 47 a day |

All six are optional: unset or empty means the safe default above (an empty value never means "no limit").

In production the API **refuses to start** without `RESEND_API_KEY`,
`EMAIL_FROM` and `APP_URL`. Without a key it never runs in dry run silently.
At startup it logs either `E-mail delivery via Resend, from …` or a
`DRY RUN` warning.

## 6. Local testing without e-mailing students

The local database contains demo accounts, and may contain real addresses
copied from production. Two safeguards:

- **No key (default):** dry run. Nothing leaves the machine; the log shows
  `[DRY RUN] "subject" → j***e@…`.
- **Key + redirect:** set `RESEND_API_KEY` and `EMAIL_REDIRECT_TO=you@…`
  in `.env`. Every e-mail goes to your inbox instead, and its subject starts
  with `[to original@address]`. Always set the redirect when you use a real
  key locally.

Resend also provides test addresses that never reach a person:
`delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`.

```bash
npm run email:check                       # key valid? domain verified?
npm run email:check -- you@example.org    # send a branded test e-mail
```

Full flow on your machine (API on :3000, frontend on :3001):

1. In `.env`, set `RESEND_API_KEY`, `EMAIL_REDIRECT_TO=<your inbox>` and
   `APP_URL=http://localhost:3001`.
2. Start the API with `npm run start:dev` and the frontend with
   `npm run dev`.
3. Open http://localhost:3001/forgot-password and enter the e-mail of a
   local account (e.g. a demo student).
4. Within about 10 seconds, the e-mail arrives in your inbox. Click
   **Reset my password**: the frontend opens `/reset-password?token=…`.
   Choose a password, then log in with it. A second e-mail, "Your password
   was changed", follows.
5. As an administrator, invite a user from user management with any address.
   The "Activate your account" e-mail arrives in your inbox. The button
   opens `/activate?token=…`.

Automated tests (`npm test`, `npm run test:e2e`) never contact Resend. The
e2e test `email-delivery` runs the real SDK against a fake Resend API.

## 7. Production deployment

1. Domain verified in Resend (§3), DMARC updated (§4).
2. Render → service → **Environment**: set `RESEND_API_KEY`. Check that
   `APP_URL` is the public frontend address, and that `EMAIL_REDIRECT_TO`
   is **not** set. Save; Render redeploys.
3. Apply the database migration `20261120000000_email_html_body`
   (`npx prisma migrate deploy` with the direct Neon string,
   deploy/render/README.md §1).
4. Check the logs for `E-mail delivery via Resend, from Rwanda Olympiad
   Foundation <info@rwandaolympiadfoundation.org>`.
5. Run the checks in §8.

## 8. Verifying real delivery

- [ ] `npm run email:check -- <inbox>`: "Accepted by Resend", and the
      e-mail arrives (check the spam folder too).
- [ ] In Resend → **Emails**, the message shows **Delivered**.
- [ ] In Gmail → ⋮ → **Show original**: `SPF: PASS`, `DKIM: PASS` (domain
      rwandaolympiadfoundation.org), `DMARC: PASS`.
- [ ] Forgot-password e-mail arrives; its link opens the reset page; the
      new password works; reusing the link fails.
- [ ] Invitation e-mail arrives; its link opens the activation page; the
      account activates; the welcome e-mail arrives.
- [ ] Administrators: Reports → overview → `actionRequired.failedEmails`
      stays at 0.

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Log: `DRY RUN` | `RESEND_API_KEY` is not set in this environment |
| API won't start: `RESEND_API_KEY is required in production` | Set the key (and `EMAIL_FROM`, `APP_URL`) in the hosting environment |
| `Resend 422 validation_error: Invalid from field` (delivery FAILED after 1 attempt), or API won't start: `EMAIL_FROM must look like …` | `EMAIL_FROM` is not `Name <address>`. In Render type it **without quotes**: `Rwanda Olympiad Foundation <info@rwandaolympiadfoundation.org>`. (Quotes and spaces wrapped around the whole value are removed automatically since 2026-11-07.) |
| `Resend 401 invalid_api_key` / `missing_api_key` | The key is wrong, was deleted, or has a space or quotes around it. Create a new key |
| `Resend 401 restricted_api_key` | A Sending access key was used for something else (e.g. listing domains). Normal for `email:check` |
| `Resend 403 validation_error: … domain is not verified` | Finish §3; the `EMAIL_FROM` domain must match the verified domain exactly |
| `Resend 403 … You can only send testing emails to your own email address` | The domain is not verified yet; until then Resend only delivers to the account owner's address |
| `Resend 422 validation_error` (delivery FAILED after 1 attempt) | The recipient address is invalid. Correct the user's e-mail |
| `Resend 429 rate_limit_exceeded` | Not a failure: the delivery is re-queued without spending an attempt and this instance pauses sending for 60 s. If it recurs, lower `EMAIL_MAX_PER_SECOND` to the plan's limit |
| `daily_quota_exceeded` / `monthly_quota_exceeded` | Not a failure (e-mails and decision notices alike): queued e-mails stay PENDING (attempts not spent, one-time links kept) and every sender pauses — daily: until just after 00:00 UTC; monthly: 12–24 h — then drains by itself. With the budget of §10 this should not happen; if it does, something else sends with the same key. Rows that FAILED for this reason before 2026-11-24 can be queued again from the admin E-mail page (§10) |
| Admin E-mail page: "Daily e-mail limit reached — N e-mails are waiting" | Normal on the Free plan (§10): the day's budget is used up; urgent e-mails (password resets, invitations, confirmations) go first right after 00:00 UTC (02:00 Kigali time) |
| Delivery status DISCARDED | Not sent on purpose: its one-time link died while it waited (expired, replaced by a newer link, account already activated). The reason is shown; the person requests a new link (§10) |
| Accepted by Resend but not received | Resend → Emails → the message: *Bounced* (address does not exist), *Complained*, or *Delivered* (then look in spam/quarantine; in Google Workspace check the admin quarantine) |
| Lands in spam | DKIM/SPF/DMARC not all PASS (§8); avoid link shorteners; set the support e-mail setting so the footer has a real contact |
| Links point to the wrong site | `APP_URL` is wrong (it must be the frontend, not the API) |
| Reset link "invalid or has expired" | Older than 30 minutes, already used, or a newer link was requested. Request a new one |
| Nothing is sent at all, no errors | `WORKERS_ENABLED=false` on every instance, or the instance is asleep (Render free plan wakes on the next request) |

## 10. Staying within the Resend Free plan (100 a day, 3,000 a month)

Owner decision 2026-11-24: the platform stays on Resend's **Free plan permanently** — at most **100 e-mails a day and
3,000 a month**. The API enforces this itself, so the provider's limit is never the thing that stops mail.

**What is counted.** Every e-mail handed to Resend: outbox e-mails (`EmailDelivery` SENT, by `attemptedAt`) and decision
notices (`NotificationOutbox` SENT, by `sentAt`), plus those being sent at that moment. Resend counts every To/CC/BCC
recipient as one e-mail; the platform sends each e-mail to exactly one recipient (no CC/BCC), so one row is one e-mail.
On the Free plan Resend also counts *received* e-mails; the platform receives none through Resend (replies go to the
Google Workspace mailbox) — if inbound e-mail is ever enabled in Resend, lower the limits accordingly.

Two windows:
- **Day = the UTC calendar day.** Resend's daily quota resets at **00:00 UTC** (02:00 in Kigali)
  ([account quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)), so the platform counts
  the same day and resumes right after 00:00 UTC.
- **Month = a rolling 31 days.** Resend's monthly period (calendar month or billing cycle) is at most 31 days long, so
  it always lies inside some 31-day window: 2,900 in *any* 31 days can never be more than 2,900 in Resend's month,
  whichever way it is aligned. (A calendar month of our own could be misaligned with a billing cycle; a rolling 30 days
  could let 31-day months through over the limit.)

**The budget** = limit − safety margin: **95 per UTC day** and **2,900 per 31 days** by default (§5). A limit of `0`
means "no limit" for that window, so a move to Resend Pro is two settings: `EMAIL_DAILY_LIMIT=0`,
`EMAIL_MONTHLY_LIMIT=50000`. E-mails are sent most urgent first, and part of each day is kept for the urgent ones:

| Priority | E-mails | May send while today (UTC) / the last 31 days hold fewer than |
|---|---|---|
| CRITICAL | password reset, invitation, e-mail confirmation, "password changed", Super Admin security notices, application approvals (coach, teacher), school verified, permissions granted | 95 / 2,900 (the whole budget) |
| NORMAL | welcome, account approved, application declined, information requests, notifications, subscriber welcome, contact form, test mailings, other decision notices | 76 / 2,320 (80 %) |
| BULK | administrators' bulk e-mails, subscriber mailings, test results published to students | 47 / 1,450 (50 %) |

So a mailing can never use the last 48 slots of a day, and ordinary e-mails never the last 19: a password reset still
goes out when only the reserve is left.

**When the budget is used up** nothing is sent and nothing fails: e-mails stay PENDING with their attempts untouched.
The worker computes the next slot — just after 00:00 UTC for the day, or when the oldest e-mail leaves the 31 days —
and sleeps until then (no polling of Resend), then sends by itself, most urgent first. A provider quota answer
(429) pauses every sender the same way: daily until just after 00:00 UTC, monthly 12–24 hours. Several API instances share one budget (a database lock around the check and the claim).

**Never a dead link.** Account e-mails carry their link's expiry and token. Just before sending (and every minute while
they wait) the link is checked; when it cannot work any more the e-mail is **DISCARDED** — never sent, its text (which
holds the link) erased — with a plain reason, e.g. *"Not sent: the password-reset link expired before it could be sent
(daily e-mail limit). The person can request a new link."* Discarded when:

- password reset: the link expired, was used, or a newer reset was requested (only the newest is ever sent — a new
  request drops the older waiting ones);
- invitation / e-mail confirmation: the account is already activated (e.g. by an administrator), the link was used or
  replaced by a newer one, the account no longer exists, or the link expired (48 h / 7 days).

Nothing that cannot be proved dead is discarded.

**Password reset: 30 minutes from sending.** A reset may wait for budget. When its e-mail is handed to Resend the
token's expiry is moved to *now + 30 minutes* (only ever later, only while unused and unexpired; the token itself — and
so the e-mail text — never changes, which keeps the idempotency key safe). If it could not be sent within 30 minutes of
the request it is discarded instead, and the person asks again: "Forgot password" always answers the same generic
message, whether or not the account exists.

**E-mails queued before 2026-11-24** (no kind, no expiry) are classified by the worker from their subject (exact
titles of the templates) and `createdAt` + the template's lifetime, the token matched by account and time, and then
treated exactly like new ones — no manual SQL is needed after the release.

**Administrators: Admin → E-mail → "Sending today"** (`GET /api/v1/admin/email/usage`, permission `email.bulkSend`):
e-mails used today (UTC day, `sent.today`) and in the last 31 days (`sent.last31d`) — plus the last 24 hours and this
calendar month for information — the limits and margins (`null` = no limit), what is left, when the day resets
(`dayResetsAt`), the next free slot (shown in Kigali time), what is waiting by priority, failed and discarded counts with
the discard reasons, whether sending is paused and why (budget, or the provider's last limit answer — never a key,
address or e-mail text), and whether this is a dry run.

**Recovery of e-mails lost to the old quota handling.** Before 2026-11-24 a 429 quota answer on the decision-notice path
counted as a failed attempt, so notices ended FAILED ("Resend 429 daily_quota_exceeded …"). The panel offers *"Retry
e-mails that failed only because of the daily limit (N)"* (`POST /api/v1/admin/email/usage/recover`, audited as
`RECOVER_QUOTA_FAILED_EMAILS`): it re-queues FAILED e-mails and decision notices whose **only** recorded failure is a
provider limit answer, and only if still meaningful — the recipient account still exists and is active, a mailing's
subscriber is still subscribed, the e-mail's text was kept, and for approvals the decision still stands (the teacher or
coach application is still APPROVED, the permission grant still exists). Link e-mails are checked again before sending.
It is an explicit administrator action, never automatic, so nothing is re-sent until someone decides to; a second click
finds nothing (409).

**Tests and staging.** Dry-run mode counts too (the SENT rows are real rows), so staging behaves like production. The
e2e suites run with a budget they never reach, except `test/email-budget.e2e-spec.ts`, which uses the real defaults.
