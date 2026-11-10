# Super Admin operator commands (runbook)

`scripts/super-admin.ts` (P1-08). CLI only: there is no HTTP endpoint, and no deployment runs it.

## Before any production run
- Get a **separate, recorded approval** from the owner, with an approval reference.
- **Rehearse first** on a Neon point-in-time copy of production, never on production directly; delete the copy afterwards.
- The operator needs the production `DATABASE_URL` (owner-held). Run from a trusted machine; the command prints no connection details.

## Bootstrap — the first Super Admin
```
npx tsx scripts/super-admin.ts bootstrap --username <admin> --confirm-username <admin> --reason "<why>"
```
- **Refuses** while any active Super Admin exists, if the target is not an existing, active, activated ADMIN, or if `--confirm-username` differs.
- **Effect** (one transaction):
  - the role becomes `SUPER_ADMIN`;
  - all the target's sessions end;
  - a `SUPER_ADMIN_BOOTSTRAP` audit row is written.

  Every active Super Admin is then e-mailed.
- **Verify:**
  - the owner signs in and `/me/permissions` shows `SUPER_ADMIN`;
  - the audit row exists.

## Break-glass (AS1)
Only for a lost or compromised Super Admin account, with `--reason` **and** `--approval-ref`. Optional: `--note`.

- **(a) Reset the credentials of an existing Super Admin:**
  ```
  npx tsx scripts/super-admin.ts break-glass reset-credentials --username <super-admin> --reason "<why>" --approval-ref <ref>
  ```
  - Sets a new one-time password, printed **once**. Hand it over securely and change it at first sign-in.
  - Ends all of that account's sessions.
- **(b) Promote one existing, active ADMIN, only when no active Super Admin exists:**
  ```
  npx tsx scripts/super-admin.ts break-glass promote-admin --username <admin> --reason "<why>" --approval-ref <ref>
  ```

Each command writes one `SUPER_ADMIN_BREAK_GLASS` audit row in the same transaction: reason, approval reference, note, before/after, never secrets. Every active Super Admin is e-mailed.

**Follow-up:**
- rotate the affected password;
- review the audit log;
- record the outcome against the approval reference.

## Exit codes
| Code | Meaning |
|---|---|
| 0 | done |
| 2 | usage error |
| 3 | refused (nothing changed) |

## Safeguards that always apply
- **The last active Super Admin cannot be removed:** service rule (409 `LAST_SUPER_ADMIN`) plus a database trigger (migration M4), so direct SQL is refused too.
- **Super Admins never grade or author assignments.**
- **`SUPER_ADMIN_BOUNDARY_ENABLED`** is off by default. Switching it on is a separate approval, after the bootstrap is verified.
