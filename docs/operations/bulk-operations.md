# Bulk operations — the generic engine (contract and runbook)

Since 2026-11-19 every bulk action runs on one engine (`src/bulk/`). Capability: `bulkOperationsGeneric` (the USER
routes of 2026-11-17 keep `bulkUserOperations`). The USER record type — its actions, filters, codes and limits — is
described in [bulk-user-operations.md](bulk-user-operations.md); this document is the contract every record type
(USER today; the next record types extend it, never a separate processing path) follows.

## Supported record types

| Record type | Routes | Selection filters | Limits | Export |
|---|---|---|---|---|
| `USER` | `/admin/bulk/USER/*` and, unchanged, `/admin/users/bulk/*` | those of `GET /admin/users` | ids ≤ 1 000; filter ≤ 50 000 | `users.export` (CSV, never dates of birth or phone numbers) |

`GET /api/v1/admin/bulk/actions` returns the record types and the actions **the caller** may run now.

## Routes

Every route needs `users.bulkManage` (only Administrators and Super Administrators hold it). It is the gate, **never
sufficient**: each action also needs its own permissions (below).

| Route | What |
|---|---|
| `GET /admin/bulk/actions` | `{ gate, entityTypes: [{ entityType, maxIds, maxSelection, export, actions: [{ action, permissions, requiresReason, consequence }] }] }` — computed from the caller's effective permissions (role defaults, GRANT / DENY overrides, expiry): an action is listed only if the caller holds `users.bulkManage` and every one of its permissions |
| `POST /admin/bulk/{entityType}/preview` | `{ action, params?, selection }` → `total`, `sample` (≤ 10), `warnings`, `consequences`, `requiresReason`, `requiresStepUp`, `selectionToken`, `confirmationExpiresAt`, `entityType`. Changes nothing |
| `POST /admin/bulk/{entityType}` | `{ action, params?, selection, selectionToken, expectedTotal, confirm: true, idempotencyKey, reason?, currentPassword? }` → `202 { operation, alreadyExisted: false }`; the same key again → `200 { operation, alreadyExisted: true }` |
| `POST /admin/bulk/{entityType}/export` | `{ selection }` → CSV (record types with an export; also needs the type's export permission) |
| `GET /admin/bulk/operations` | your operations of every type, newest first (`?status=`, `?entityType=`); all operations with `audit.view` |
| `GET /admin/bulk/operations/{id}` | status, `total`, `succeeded`, `failed`, `skipped`, `pending`, `processing`, `processed` |
| `GET /admin/bulk/operations/{id}/items` | per record (`?outcome=`): `entityId`, `userId` (USER only), `outcome`, `code`, `message`, `stillBlockedBy`, `processedAt`, and the record's summary (USER: `user`) |
| `POST /admin/bulk/operations/{id}/cancel` | records not yet processed → `SKIPPED CANCELLED`; processed ones keep their result |

`selection` is `{ mode: 'ids', ids }` or `{ mode: 'filter', filter }`, and `selection` / `params` are validated with the
record type's own rules — for USER exactly those of `/admin/users/bulk` (unknown filters or values → `400 VALIDATION_FAILED`).
`/admin/users/bulk/*` only ever show USER operations.

## The confirmation (`selectionToken`, v2)

Opaque to clients (≤ 200 characters). Issued by the preview, valid **15 minutes** (`confirmationExpiresAt`), for the
administrator who previewed only:

```
v2.<administrator id>.<count>.<expires, unix seconds>.<binding digest>.<signature>
binding digest = base64url(SHA-256(canonical JSON {v, administrator, record type, action, parameters, selection}
                                   + every matching record id, sorted))
signature      = base64url(HMAC-SHA256(key, everything before it)), compared in constant time
key            = HMAC-SHA256(JWT_SECRET, "rof:bulk-confirmation:v2")   (no new secret; never logged)
```

At execution, in this order — nothing is created on any refusal:

1. signature and format (also every pre-2026-11-19 v1 token) → `400 CONFIRMATION_INVALID`;
2. another administrator → `403 CONFIRMATION_WRONG_ADMINISTRATOR`;
3. older than 15 minutes → `410 CONFIRMATION_EXPIRED`;
4. under the record type's membership guard, the binding is recomputed from the request and from the records the
   selection matches **now**: another action, other parameters, another selection or another record set (even with
   the same count), or another `expectedTotal` → `409 SELECTION_CHANGED`;
5. a confirmation creates **at most one operation**: executed again with another `idempotencyKey` → `409
   CONFIRMATION_USED` (enforced by a partial unique index on v2 confirmations); with the same key → the same operation.

Clients: on any of these, preview again.

## Engine contract

### Action definition

A record type declares, per action (`BulkActionMeta`):

- `permissions` — what the caller needs **on top of** `users.bulkManage`: exactly the permissions of the action's
  single-record route (USER status actions: `users.manage` and the transition's permission, as
  `POST /admin/users/:id/status-changes`);
- `reason` — `required` (3–500 characters) or `optional`;
- `consequence` — one sentence for the confirmation dialog;
- parameter normalisation and validation (`normaliseParams`, `validate`: the single route's request checks, e.g.
  `SAME_TEACHER`, `NOT_A_TEACHER`, `ROLE_NOT_ALLOWED_IN_BULK`).

### Authorization hooks (all three always apply)

1. **Gate** — `users.bulkManage` on every route.
2. **Action permissions** — checked at preview and at execute (a permission removed or denied between preview and
   execute → `403 PERMISSION_REQUIRED`, nothing created), and **again for every record** by the worker with the
   administrator re-loaded from the database (removed after the operation was created → that record `FAILED
   PERMISSION_REQUIRED`, nothing changed; a deactivated administrator → `FAILED ACTOR_NOT_AUTHORIZED`).
3. **Per-record policy** — the handler's `processItem` calls the same service code as the single-record route (USER:
   `AccountStatusService.change`, `UsersService.update` with `RoleAssignmentPolicy` and the Super Admin rules, the
   teacher–student `*InTx` helpers), inside the item transaction; its refusals are recorded per record. The
   administrator's own record is skipped (`SELF`). Bulk never allows more than the single route.

### Lifecycle

`PENDING` (created) → `RUNNING` (first batch claimed) → `COMPLETED` (no failure) | `COMPLETED_WITH_FAILURES` |
`FAILED` (nothing succeeded or was skipped); cancel: `PENDING`/`RUNNING` → `CANCELLING` (until claimed records finish)
→ `CANCELLED`. Audit: `BULK_OPERATION_STARTED` (administrator, record type, action, parameters — never a message body —,
selection criteria, total, reason, request id, step-up) and `BULK_OPERATION_FINISHED` (status and counts), once each;
`BULK_OPERATION_CANCELLED`. Each record's change is audited exactly as the single route audits it, with the operation id.

### Per-record outcomes

`PENDING` → `PROCESSING` (claimed) → `SUCCEEDED` (changed — `code` may say how, e.g. `ALREADY_ASSIGNED_TO_NEW_TEACHER`),
`SKIPPED` (nothing to do: `SELF`, `CANCELLED`, `NOT_FOUND`, `ALREADY_IN_STATE`, `ALREADY_SET`, `NOT_APPLICABLE`,
`NOT_A_STUDENT`, `NOT_ASSIGNED_TO_SOURCE`, … and the type's `skipCodes`) or `FAILED` (refused, nothing changed:
`PERMISSION_REQUIRED`, `ACTOR_NOT_AUTHORIZED`, the single route's refusal code such as `ROLE_NOT_ASSIGNABLE`,
`REASON_REQUIRED`, or `UNEXPECTED_ERROR`). Partial success keeps every successful result.

### Retries and recovery

- **Idempotency** — one operation per (administrator, `idempotencyKey`), enforced by a unique index; the same key, also
  concurrently, returns that operation (`200`); a key used for another record type → `409 IDEMPOTENCY_KEY_REUSED`.
- **Exactly once per record** — one item per (operation, record), unique. A worker claims up to **200** items
  (`FOR UPDATE SKIP LOCKED`, claim token); each record is processed in **its own transaction** that holds the operation
  row `FOR SHARE`, the item `FOR UPDATE`, re-checks the claim, makes the change and records the result — both or
  neither. Notices and e-mails are written in that transaction (outbox rows, de-duplicated per operation) and dispatched
  only after it commits: never on rollback, never twice on retry.
- **Recovery** — a worker that dies leaves its item `PROCESSING` with nothing changed; after 5 minutes another worker
  takes the claim over and applies it once. A stalled worker whose claim was taken over cannot record (its change rolls
  back). A deadlock returns the item to `PENDING`. A finishing sweep ends operations whose last batch could not.
- **Membership consistency** — the operation's items equal the selection's exact membership at the moment it commits:
  the creation takes the record type's guard (USER: advisory lock `8152026002` exclusively, writers take it shared via
  trigger `user_bulk_membership_guard`; other types: `LOCK TABLE … IN SHARE MODE` on every table the filter reads, which
  waits for writes in flight and holds new ones until the operation is created), scans, checks the confirmation, inserts,
  and re-scans.

### Adding a record type or an action

1. Implement `BulkEntityHandler` (`src/bulk/bulk-handler.ts`) in the record type's module: `entityType` (upper case),
   `actions`, `selectionDto` / `paramsDto` (the list endpoint's filters, the action parameters), `count` / `scanIds`
   (the list endpoint's where clause), `membership` (tables the filter reads, or an advisory key with a guard trigger),
   `preview` (sample, warnings), `processItem` (calls the single-record service inside `ctx.tx`; enqueue notices into
   `ctx.noticeIds`, post-commit work into `ctx.afterCommit`), `describe`, optional `export`, `onCreate`, `auditParams`,
   `stepUpRequired` / `assertStepUp`, `isSelf`, `skipCodes`.
2. Register it in `onModuleInit` with `BulkRegistry.register(this)`. Nothing else in the engine changes.
3. A new action on an existing type: add it to the type's actions with the single route's permissions, reason rule and
   consequence, normalise / validate its parameters, and handle it in `processItem` by calling the single route's service.
4. Declare nothing new for routes (the generic routes serve every type); add tests: each action positive, refused
   without each of its permissions (preview, execute, per record), per-record refusals, idempotency, notices once, and a
   membership race for a new type.
