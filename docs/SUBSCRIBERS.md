# News subscribers and mailings

Owner decision 2026-11-23: anyone — parents, schools, the public — leaves an e-mail address on the website to receive
Rwanda Olympiad Foundation news and Olympiad announcements. Administrators see the list, export it, send updates, and
people unsubscribe with one click. No payment. Capability: `subscribers` (GET /api/v1).

## Routes

| Route | Who | What |
|---|---|---|
| `POST /api/v1/public/subscribe` | public, 10 per hour per IP | `{ email, fullName?, kind?, interests?, country?, website? }` → always **202** with the same answer |
| `POST /api/v1/public/unsubscribe` | public, 30 per hour per IP | `{ id, token, reason? }` from the link `/unsubscribe?s=<id>&t=<token>` → 200 `{ unsubscribed: true }`; invalid link → 400 `INVALID_UNSUBSCRIBE_LINK` |
| `POST /api/v1/public/unsubscribe/one-click?s=&t=` | public, 30 per hour per IP | RFC 8058 one-click (mail clients POST `List-Unsubscribe=One-Click`) |
| `GET /api/v1/admin/subscribers` | `subscribers.manage` | list: `q` (e-mail or name), `status`, `interest`, `kind`, `source`, `country`, `sort` (newest, oldest, name, email), `page`, `limit` |
| `GET /api/v1/admin/subscribers/summary` | `subscribers.manage` | active and unsubscribed counts; active by source, kind, interest |
| `GET /api/v1/admin/subscribers/export` | `subscribers.manage` | the filtered list as CSV (streamed, formula-safe, audited) |
| `POST /api/v1/admin/subscribers` | `subscribers.manage` | add one (source ADMIN); 409 `SUBSCRIBER_EXISTS` / `SUBSCRIBER_UNSUBSCRIBED` |
| `POST /api/v1/admin/subscribers/import[?dryRun=true]` | `subscribers.manage` | CSV (≤ 1 MB, ≤ 5,000 rows): `email` (required), `name`, `kind`, `interests` (`;` `,` or `\|`; Mathematics, Physics, Computing, or All), `country` (RW…) |
| `PATCH /api/v1/admin/subscribers/:id` | `subscribers.manage` | name, kind, interests, country; `status` UNSUBSCRIBED (reason optional) or ACTIVE (reason **required**) |
| `DELETE /api/v1/admin/subscribers/:id` | `subscribers.manage` | erase (a privacy request); their e-mails not yet sent are withdrawn |
| `POST /api/v1/admin/subscribers/mailings/preview` | `subscribers.manage` | `{ audience }` → `{ recipients }` |
| `POST /api/v1/admin/subscribers/mailings/test` | `subscribers.manage` | `{ subject, body }` → the e-mail to the caller only |
| `POST /api/v1/admin/subscribers/mailings` | `subscribers.manage` | `{ subject, body, audience?, idempotencyKey }` → the mailing (QUEUED) |
| `GET /api/v1/admin/subscribers/mailings[/:id]` | `subscribers.manage` | history with delivery counts; detail with the body |
| `POST /api/v1/admin/subscribers/mailings/:id/cancel` | `subscribers.manage` | withdraw what is not sent yet (QUEUED or SENDING); 409 once sent |

`subscribers.manage` is held by Administrators and Super Admins (global); no other role. Every Administrator change,
export, import, mailing, cancellation and test is in the audit log (category SUBSCRIBERS); public subscribe and
unsubscribe are recorded without an actor.

## Rules

- **One row per address**, stored trimmed and lower-case. `interests` empty = every subject. `kind` (Parent, Student,
  Teacher, School, Other) and `country` are optional. `userId` links the account with the same e-mail (information only).
- **No enumeration.** Subscribing answers the same whether the address is new, already listed or unsubscribed. An
  existing active row is never overwritten from the website (missing name, kind or country are filled in; interests
  are merged). An unsubscribed address that subscribes again becomes active again.
- **Welcome e-mail** only when an address becomes active from the website — so whoever owns it can leave at once. Rows
  added or imported by an Administrator receive no welcome.
- **Unsubscribe link** in every subscriber e-mail: `<APP_URL>/unsubscribe?s=<id>&t=<token>`, token =
  HMAC-SHA256(`JWT_SECRET`, `subscriber-unsubscribe:<id>`), base64url. Nothing is stored. Changing `JWT_SECRET`
  invalidates older links (newer e-mails carry new ones).
- **List-Unsubscribe headers** on every subscriber e-mail. With `API_PUBLIC_URL` set (the API's public https address,
  without `/api/v1`), they announce RFC 8058 one-click (`List-Unsubscribe-Post`) to the backend; without it they point to
  the frontend page.
- **Unsubscribed rows stay** (status UNSUBSCRIBED, date and reason) so an import never adds the address again. Only the
  person (subscribing again) or an Administrator with a reason makes them active again. Erasing a row forgets the
  address entirely.

## Mailings

- The audience is `{ interests?, kinds?, countries? }`; empty = every ACTIVE subscriber. Interests match anyone with one of
  them or with no interest chosen. UNSUBSCRIBED rows are never included; addresses are unique.
- A mailing creates one EmailJob and one EmailDelivery per recipient (`subscriberId` set) in the existing outbox, so the
  worker's rate limit (`EMAIL_MAX_PER_SECOND`), provider-limit pauses, retries and delivery tracking (Admin · E-mail)
  apply. The body is plain text (blank lines separate paragraphs) in the branded template; the worker adds the
  greeting, the subscriber's own unsubscribe link and the headers at send time.
- Deliveries wait **2 minutes** before they may be sent: during that time the mailing can be cancelled and nothing goes
  out. Someone who unsubscribes before their e-mail is sent is skipped (the delivery is marked failed with that reason).
- Status: QUEUED (nothing sent yet) → SENDING → SENT (or FAILED when nothing could be sent); CANCELLED. Counts come from
  the deliveries. The same `idempotencyKey` returns the same mailing (a double click sends once).

## Privacy notes

- Collected: e-mail address, and optionally name, kind, interests and country — only what is needed to send the news.
- The subject and body of a mailing are not written to the audit log; exports are audited with their filters.
- Public answers never reveal whether an address is on the list.
- Database: migration `20261229000000_subscribers` (additive); rollback `docs/migrations/20261229000000_subscribers.rollback.sql`
  (refuses while subscribers exist unless `SET rof.subscribers_rollback = 'discard-subscribers'`; export the list first).
