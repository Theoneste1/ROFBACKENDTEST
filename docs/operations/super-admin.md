# Super Admin operator commands (runbook)

`src/super-admin/cli.ts` (P1-08), compiled to `dist/super-admin/cli.js` by `npm run build` (it is also in the runtime image). CLI only: there is no HTTP endpoint, and no deployment runs it.

> Run the **compiled** command (`node dist/super-admin/cli.js …` or `npm run super-admin -- …`). It boots the Nest application, which needs the decorator metadata that `tsc` emits; through `tsx` the services are not injected and the command crashes before doing anything.

## Before any production run
- Get a **separate, recorded approval** from the owner, with an approval reference.
- **Rehearse first** on a Neon point-in-time copy of production, never on production directly; delete the copy afterwards.
- The operator needs the production `DATABASE_URL` (owner-held). Run from a trusted machine; the command prints no connection details.
- The target is a **personal** Administrator account, identified by its **username only** (the owner reads it on their profile after signing in, or an Administrator finds it under Users → Administrators). No password, token or connection detail is needed or shared.

## Dry run — check the target first (changes nothing)
```
node dist/super-admin/cli.js bootstrap --username <admin> --dry-run
```
Prints the target's username, name, current role, active and activated status, the number of active Super Admins, and whether the bootstrap would go ahead or which refusal code it would give. It only reads: nothing is written, no session ends, no audit row, no e-mail.

Exit code 0 means the bootstrap would go ahead; 3 means it would be refused (the code is printed).

## Bootstrap — the first Super Admin
```
node dist/super-admin/cli.js bootstrap --username <admin> --confirm-username <admin> --reason "<why>"
```
- **Refuses** (nothing changed):
  - while any active Super Admin exists;
  - if the target is not an existing, active, activated ADMIN;
  - if the target is the **shared seeded account** (`admin`, or the username in `SEED_ADMIN_USERNAME`);
  - if `--confirm-username` differs.
- **One at a time:** every promotion takes a database advisory lock before it checks for an existing Super Admin, so two runs at the same moment cannot both succeed. The second waits, then is refused with `SUPER_ADMIN_EXISTS`.
- **Effect** (one transaction; any failure rolls all of it back):
  - the role becomes `SUPER_ADMIN`;
  - all the target's sessions end;
  - a `SUPER_ADMIN_BOOTSTRAP` audit row is written (operator, reason, before/after role; never secrets).

  Every active Super Admin is then e-mailed.
- **Verify:**
  - the owner signs in and `/me/permissions` shows `SUPER_ADMIN`;
  - the audit row exists;
  - a dry run now reports 1 active Super Admin and `SUPER_ADMIN_EXISTS`.

## Break-glass (AS1)
Only for a lost or compromised Super Admin account, with `--reason` **and** `--approval-ref`. Optional: `--note`. (`--dry-run` is for the bootstrap only.)

- **(a) Reset the credentials of an existing Super Admin:**
  ```
  node dist/super-admin/cli.js break-glass reset-credentials --username <super-admin> --reason "<why>" --approval-ref <ref>
  ```
  - Sets a new one-time password, printed **once**. Hand it over securely and change it at first sign-in.
  - Ends all of that account's sessions.
- **(b) Promote one existing, active ADMIN, only when no active Super Admin exists:**
  ```
  node dist/super-admin/cli.js break-glass promote-admin --username <admin> --reason "<why>" --approval-ref <ref>
  ```
  Same restrictions as the bootstrap: never the shared seeded account, and the same lock.

Each command writes one `SUPER_ADMIN_BREAK_GLASS` audit row in the same transaction: reason, approval reference, note, before/after, never secrets. Every active Super Admin is e-mailed.

**Follow-up:**
- rotate the affected password;
- review the audit log;
- record the outcome against the approval reference.

## Refusal codes
All refusals change nothing (exit code 3).

| Code | Meaning |
|---|---|
| `OPERATOR_INPUT_REQUIRED` | `--reason` or `--approval-ref` missing or shorter than 3 characters |
| `CONFIRMATION_MISMATCH` | `--confirm-username` does not repeat `--username` exactly |
| `NOT_AN_ACTIVE_ADMIN` | the target does not exist, is not an ADMIN, is suspended, or was never activated |
| `SHARED_ACCOUNT_REFUSED` | the target is the shared seeded account (`admin` or `SEED_ADMIN_USERNAME`) |
| `SUPER_ADMIN_EXISTS` | an active Super Admin already exists (bootstrap, promote-admin) |
| `NOT_A_SUPER_ADMIN` | reset-credentials named an account that is not a Super Admin |

## Exit codes
| Code | Meaning |
|---|---|
| 0 | done (dry run: the bootstrap would go ahead) |
| 2 | usage error |
| 3 | refused, nothing changed (dry run: the bootstrap would be refused) |

## Safeguards that always apply
- **The last active Super Admin cannot be removed:** service rule (409 `LAST_SUPER_ADMIN`) plus a database trigger (migration M4), so direct SQL is refused too.
- **Only a Super Admin manages Super Admins:** an Administrator cannot promote anyone, including themselves, and nobody can change their own role.
- **Super Admins never grade or author assignments.**
- **`SUPER_ADMIN_BOUNDARY_ENABLED`** is off by default. Switching it on is a separate approval, after the bootstrap is verified.
