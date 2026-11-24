# Account states (runbook)

Since 2026-11-16 every account has an **account state** (`User.accountStatus`). Accounts are never deleted through
the API: an account that should no longer be used is **archived**, and everything linked to it is kept.

| State | Meaning | Sign-in |
|---|---|---|
| `ACTIVE` | Normal access. | yes (if activated and approved) |
| `DEACTIVATED` | Temporarily switched off, e.g. a student leaving for a year. | no — `ACCOUNT_DEACTIVATED` |
| `SUSPENDED` | Blocked by an administrative restriction (investigation, misuse). | no — `ACCOUNT_SUSPENDED` |
| `ARCHIVED` | Kept for history and administration only, e.g. a graduate. | no — `ACCOUNT_ARCHIVED` |

"Restored" is not a state: it is the change from `ARCHIVED` (or `DEACTIVATED` / `SUSPENDED`) back to `ACTIVE`.

## Allowed changes

| from \ to | ACTIVE | DEACTIVATED | SUSPENDED | ARCHIVED |
|---|---|---|---|---|
| **ACTIVE** | — | deactivate | suspend | archive |
| **DEACTIVATED** | reactivate | — | suspend | archive |
| **SUSPENDED** | lift the suspension | ✗ | — | archive |
| **ARCHIVED** | restore | ✗ | ✗ | — |

- Same state again: `409 STATUS_UNCHANGED`. A change not in the table: `409 INVALID_STATUS_TRANSITION`.
- **Reason** (3–500 characters) is required to deactivate, suspend or archive, and to restore an archived account:
  `400 REASON_REQUIRED`. Reactivating and lifting a suspension need none.
- **Restoring an archived account** also needs `confirm: true` (`400 CONFIRMATION_REQUIRED`).
- The rules live in one place: `src/users/account-status.ts` (unit-tested against this table).

## What a change does

One transaction, under the account's row lock:

1. the state changes (`isActive` follows it automatically: database trigger `user_account_status_sync`, so every
   existing `isActive` check — login, refresh, the JWT guard on every request, the last-Super-Admin trigger, the
   Super Admin boundary — applies to all three blocked states);
2. leaving `ACTIVE` **ends every session at once** (refresh tokens revoked, older access tokens rejected) and voids
   every unused password-reset and activation link;
3. a history row (`UserStatusChange`: from, to, reason, who, when, request id, bulk operation id) and an audit row
   (`USER_STATUS_CHANGED`) are written.

**Nothing else is touched.** Submissions and solutions, results and rankings, discussions, course and enrolment
history, school affiliations, notifications and the audit trail stay linked to the account in every state.

**A restore sets the state only.** It never clears another, independent block. The response lists what still
prevents sign-in in `stillBlockedBy`:

| Value | Meaning | What unblocks it |
|---|---|---|
| `NOT_ACTIVATED` | never activated | the activation link (re-send the invitation) |
| `PENDING_APPROVAL` | not approved yet | an administrator's approval |
| `LOCKED` | an account lock recorded by the earlier release (`User.lockedUntil`); sign-in locks now apply to one address only and do not appear here | time (at most 15 minutes) or a password reset — there is no Administrator unlock |
| `ROLE_DISABLED` | the role's feature flag is off (`TEACHERS_ENABLED`, `HEAD_COACHES_ENABLED`) | the flag |

## Who may change what

| Change | Permission (Administrators and Super Admins, global) |
|---|---|
| deactivate / reactivate | `users.changeStatus` |
| suspend / lift a suspension (incl. deactivated → suspended) | `users.suspend` |
| archive / restore from archive | `users.archive` |
| read an account's history | `users.viewStatusHistory` |

Plus, always: the right to manage the account's **current role** (`RoleAssignmentPolicy`). An Administrator never
changes a Super Admin's state, and with `SUPER_ADMIN_BOUNDARY_ENABLED` on (and a Super Admin present) not another
Administrator's either. Nobody changes their own state (`400 CANNOT_CHANGE_OWN_STATUS`). The last active Super Admin
stays active (`409 LAST_SUPER_ADMIN`, also enforced by the database).

## API

| Route | Notes |
|---|---|
| `POST /api/v1/admin/users/:id/status-changes` `{ toStatus, reason?, confirm? }` | 200 `{ user, change, stillBlockedBy }` |
| `GET /api/v1/admin/users/:id/status-history?page&limit` | 200 `{ data: [change…], meta, accountStatus }`, newest first |
| `GET /api/v1/admin/users?accountStatus=…` | list filter; every admin user record carries `accountStatus` |
| `PATCH /api/v1/admin/users/:id/status` `{ isActive }` | **compatible**: `false` → `SUSPENDED` (recorded with the reason "Suspended by an administrator (status switch)."), `true` → `ACTIVE` from `SUSPENDED` / `DEACTIVATED`; an archived account → `409 INVALID_STATUS_TRANSITION` |
| `DELETE /api/v1/admin/users/:id` | **always `409 PERMANENT_DELETION_DISABLED`** — archive instead |

Capability: `accountStates` (GET /api/v1).

**Activate now** (capability `adminActivateNow`, owner 2026-11-24): `POST /api/v1/admin/users/:id/activate-now` activates
an ACTIVE account that was never activated ("Awaiting setup") and whose person chose their own password — they then sign
in without confirming their e-mail. `activatedAt` is set; their unused activation links are revoked (never deleted); audit
`ACTIVATE_ACCOUNT` `{ via: 'admin', activatedBy, linksRevoked, operationId }`; no e-mail is sent. Needs `users.manage`,
`users.changeStatus` and the right to manage the account's role. 409 `ALREADY_ACTIVATED`, `NO_PASSWORD_YET` (resend the
invitation instead), `ACCOUNT_NOT_ACTIVE` (reactivate, lift or restore first). Response 200: `{ user, stillBlockedBy,
message }` — `user` is the account's state fields (`id`, `username`, `firstName`, `lastName`, `role`, `accountStatus`,
`isActive`, `isApproved`, `activatedAt`, `updatedAt`), `stillBlockedBy` lists what still stops sign-in (`PENDING_APPROVAL`,
`LOCKED`, `ROLE_DISABLED`; empty when they can sign in now) and `message` says so in plain words. Bulk: USER action `activateNow` (preview
`willApply` and one warning per skip reason; items SKIPPED with the same codes, or `ROLE_NOT_MANAGEABLE`).
`GET /admin/users/:id` carries `hasPassword` (never the hash).

## Existing data

The migration (`20261206000000_account_states`) gives every account a state: `isActive = false` accounts — the
"suspended" accounts of before — become `SUSPENDED`; every other account is `ACTIVE`. No row is deleted.
Rollback: `docs/migrations/20261206000000_account_states.rollback.sql` (refuses while history or a deactivated or
archived account would be lost, unless explicitly acknowledged after a backup).

## Permanent deletion

Not available. If the foundation ever needs to erase an account (a legal or privacy request), that is a separate,
tightly authorised data-management process — with its own approval, retention and audit rules — and is not part
of normal administration. Do not delete rows by hand: foreign keys protect the academic history on purpose.
