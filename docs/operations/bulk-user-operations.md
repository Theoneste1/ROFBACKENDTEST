# Bulk user operations (runbook)

Since 2026-11-17 administrators can act on many accounts at once. Capability: `bulkUserOperations`.

## How it works

1. **Select.** Either up to 1 000 accounts chosen one by one — or the current page — (`{ mode: 'ids', ids }`), or
   **every account matching the list filters, across all pages** (`{ mode: 'filter', filter }` — the filters of
   `GET /admin/users`; at most 50 000 accounts). The two are different requests: selecting a page never means "all
   matching". The browser never loads all matching accounts; the server resolves the selection.
2. **Preview** — `POST /api/v1/admin/users/bulk/preview { action, params?, selection }`. Changes nothing. Returns
   `total`, a `sample` (≤ 10 accounts), `warnings` (e.g. your own account, Administrators, accounts already in that
   state), `consequences`, `requiresReason`, `requiresStepUp` and a **`selectionToken`**.
3. **Confirm and execute** — `POST /api/v1/admin/users/bulk { action, params?, selection, selectionToken,
   expectedTotal, confirm: true, idempotencyKey, reason?, currentPassword? }` → `202 { operation }`.
4. **Follow it** — `GET /admin/users/bulk/:id` (status and counts), `GET /admin/users/bulk/:id/items?outcome=`
   (per account: SUCCEEDED / FAILED / SKIPPED, with a code), `GET /admin/users/bulk` (operations),
   `POST /admin/users/bulk/:id/cancel`.

### The confirmation is bound to the exact accounts

The `selectionToken` is a digest of the action, its parameters, the normalised selection and **the sorted ids of every
matching account**. At execution the server resolves the selection again and recomputes it. If anything differs — an
account added, removed, or swapped for another (even with the same total) — the request is refused with
`409 SELECTION_CHANGED` and nothing is created: preview again and confirm the new selection. `expectedTotal` is checked
as well.

**Validation and creation are atomic — the membership lock.** The operation's accounts equal the filter's exact
membership at the moment the operation commits:

- Every write that can change membership — an `INSERT` or `DELETE` of an account, or an `UPDATE` of a column the filters
  read (`role`, `divisionId`, `gradeLevel`, `schoolId`, `isApproved`, `isActive`, `accountStatus`, `activatedAt`, and
  for the search `firstName`, `lastName`, `username`, `email`) — takes the **membership lock** (advisory lock
  8152026002) **shared**. A database trigger (`user_bulk_membership_guard`, migration `20261207000100`) does it, so every
  writer takes part: the application, scripts and direct SQL. The filters read no other table.
- Creating an operation takes it **exclusively**, then — in the same transaction — scans the matching accounts once,
  compares the token (and the total), inserts the operation and its items, and checks a final scan equals the items.
  It waits for membership writes already in flight (their result is then seen: a different set → `409`), and holds new
  ones until it commits (they are applied right after, so an account that becomes eligible meanwhile is consistently
  not part of the operation).
- A deadlock (only possible if the administrator's own account is deleted by direct SQL at that moment) is retried up to
  three times, then `503 BULK_BUSY`; nothing is half-created.

**Disruption profile.** Shared locks never wait for each other: ordinary writes are only delayed while an operation is
being *created*, and only if they change a filtered column. Sign-ins (`lastLoginAt`, `failedLoginCount`, `lockedUntil`,
`tokensValidAfter`), points, profile pictures and the like never wait. Measured locally (lock held ≈ time a concurrent
membership write waits): **5 000 accounts ≈ 0.12 s; 50 000 accounts (the maximum) ≈ 1.5 s.**

### Retries are safe

- **The same `idempotencyKey`** (per administrator) returns the same operation (`200`, `alreadyExisted: true`); nothing
  is created or processed twice.
- **Each account is processed at most once per operation**, enforced in the database: one item per (operation,
  account) — unique. A worker claims an item (`PENDING → PROCESSING` with a claim token) and only that claim may write
  its result. **Every change and its result commit in one transaction** — status changes, role and grade changes and
  e-mail deliveries alike — so a result is never recorded without its change, nor a change without its result. If a
  worker dies mid-item, nothing of that item survived; its claim expires after 5 minutes, another worker takes it over
  and applies the change once (`SUCCEEDED`). A stalled worker whose claim was taken over cannot record: its change is
  rolled back.
- **E-mails go out at most once per account per operation**: the delivery is created together with the account's
  result.

## Actions

| Action | What it does | Needs (besides `users.bulkManage`) | Reason |
|---|---|---|---|
| `activate` | deactivated and suspended accounts → active (archived: skipped, use `restore`) | `users.changeStatus`, `users.suspend` | optional |
| `deactivate` | active → deactivated; sessions end | `users.changeStatus` | **required** |
| `suspend` | active or deactivated → suspended; sessions end | `users.suspend` | **required** |
| `archive` | → archived; sessions end; nothing deleted | `users.archive` | **required** |
| `restore` | deactivated, suspended or archived → active. Sets the state only: each account's result lists what still blocks sign-in (`stillBlockedBy`) | `users.changeStatus`, `users.suspend`, `users.archive` | **required** |
| `assignRole` `{ role }` | each account gets the role, if you may manage its current and the new role (`RoleAssignmentPolicy`). **Never `SUPER_ADMIN`** (`400 ROLE_NOT_ALLOWED_IN_BULK`). Administrator roles need your `currentPassword` (checked once, never stored) | the role policy | optional |
| `changeClassification` `{ gradeLevel }` | students move to the grade, and so to its division (S1–S3 Junior, S4–S6 Senior), re-enrolled for the current year; other roles skipped | `users.manageStudents` (via the user update) | optional |
| `message` `{ subject, body }` | one e-mail to each **active** account (blocked accounts skipped) through the existing e-mail queue | `email.bulkSend` | optional |
| export | `POST /admin/users/bulk/export { selection }` → CSV: first name, last name, username, e-mail, role, state, school, grade, created. **Never** dates of birth or phone numbers. Audited (`USERS_EXPORTED`) | `users.export` | — |

**"Classification"** means a student's grade and division: the platform classifies students by `User.gradeLevel`
(`S1`–`S6`), which fixes `User.divisionId` (Junior / Senior) and the year's `StudentEnrollment`. The user record has no
other classification field; programme membership is managed by its own routes and is not a bulk action.

Every account is processed with the same services and checks as a single change. An action never grants a
permission: an administrator who can select an account can only do to it what they could do one at a time.
Your own account is always skipped (`SELF`).

## Processing

A worker (in every API instance) claims up to **200 items at a time** (`PENDING → PROCESSING`, `FOR UPDATE SKIP LOCKED`;
a claim older than 5 minutes — a crashed worker — is taken over). Each account is changed in its own transaction, so one
failure does not undo the others. Counts are recomputed from the items. When nothing is pending or processing the
operation ends as `COMPLETED`, `COMPLETED_WITH_FAILURES` or `FAILED`, once.

**One transaction per account, in one lock order** — operation row → item row → account row (→ e-mail outbox):
the worker locks the operation `FOR SHARE` and re-reads its status, locks the item `FOR UPDATE` and re-checks its
claim, and only then changes the account, records the result and (for a message) writes the e-mail delivery — all in
that transaction. A refusal rolls it back (nothing changed) and is recorded in a second transaction under the same
locks.

**Cancelling** takes the operation row (`FOR UPDATE`), so it waits for the account being processed at that moment;
then it marks the operation `CANCELLING` and skips the accounts still `PENDING` (code `CANCELLED`; untouched). Every
account processed afterwards sees `CANCELLING` under its lock and is skipped (`CANCELLED`) with no change and no e-mail.
The operation becomes `CANCELLED` once no account is processing. Every recorded result equals what happened:
`SUCCEEDED` if and only if the account was changed (or e-mailed).

Measured locally: 5 000 accounts selected by filter — preview and creation ≈ 0.9 s, processing 25 batches ≈ 66 s.

## Audit

- `BULK_OPERATION_STARTED` (who, action, parameters — a message's subject but never its body —, the selection
  criteria, total, reason, request id) and `BULK_OPERATION_FINISHED` (final status and counts), once each;
  `BULK_OPERATION_CANCELLED`; `USERS_EXPORTED`.
- Each account's change is audited as a single change would be (`USER_STATUS_CHANGED` with the operation id, role and
  grade changes as today); the items list every account with its result.

## Errors

`400` `CONFIRMATION_REQUIRED`, `REASON_REQUIRED`, `EMPTY_SELECTION`, `SELECTION_TOO_LARGE`,
`ROLE_NOT_ALLOWED_IN_BULK`, `VALIDATION_FAILED`; `403` `PERMISSION_REQUIRED`, `STEP_UP_REQUIRED`; `404` unknown
operation (or not yours, without `audit.view`); `409` `SELECTION_CHANGED`, `OPERATION_FINISHED` (cancel); `503` `BULK_BUSY`
(a deadlock during creation persisted after three tries — try again).

Item codes: `SELF`, `ALREADY_IN_STATE`, `NOT_APPLICABLE`, `USE_RESTORE`, `ALREADY_SET`, `ACCOUNT_NOT_ACTIVE`,
`CANCELLED`, `NOT_FOUND` (skipped); `ROLE_NOT_ASSIGNABLE`, `PERMISSION_REQUIRED`, `LAST_SUPER_ADMIN`,
`TEACHERS_DISABLED`, `ACTOR_NOT_AUTHORIZED`, `UNEXPECTED_ERROR`, … (failed).
