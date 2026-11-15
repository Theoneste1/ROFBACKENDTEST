# Form availability (registration and website forms)

Administrators decide when each public form accepts submissions, and what people see while it does not. The backend enforces it: a submission to a closed form is refused even if a page still shows the form.

Code: `src/forms/`. Migration: `20261208000000_form_availability` (rollback in `docs/migrations/`). Capability: `formAvailability`.

## The forms

| Key | Form | Refused with | Before this change |
|---|---|---|---|
| `STUDENT_REGISTRATION` | Student self-registration (`POST /auth/register/student`) | 403 `REGISTRATION_CLOSED` | `registration.studentSelfSignup` (default on) |
| `TEACHER_REGISTRATION` | Teacher applications (`POST /auth/register/teacher`) | 403 `REGISTRATION_CLOSED` | `registration.teacherSelfSignup` (default off) |
| `COACH_APPLICATION` | Coach applications (`POST /mentor-requests`) | 403 `FORM_CLOSED` | always open |
| `CONTACT` | Website contact form (`POST /public/contact`) | 403 `FORM_CLOSED` | always open |

There is no competition registration in the platform, so there is no form for it.

Student and teacher registration keep the code `REGISTRATION_CLOSED`, because the live frontend already recognises it. The new forms use `FORM_CLOSED`. Every refusal has the same body:

```json
{ "code": "…", "message": "<the closed message>[ It opens on 1 December 2026, 08:00 (Kigali time).]",
  "details": { "form": "COACH_APPLICATION", "state": "NOT_YET_OPEN", "opensAt": "2026-12-01T06:00:00.000Z",
               "closesAt": null, "closedMessage": "…", "contactEmail": null, "supportUrl": null } }
```

**Teacher registration** also requires the Teacher role to be enabled (`TEACHERS_ENABLED`). While it is off, the form reports `CLOSED` whatever its settings say; they apply once the role is enabled.

**What closing a form does not affect:** sign-in, existing accounts, applications already waiting for approval, and every other part of the platform. Approval and e-mail-verification settings (`registration.studentRequiresApproval`, `registration.requireEmailVerification`) are unchanged and separate.

## Modes and states

Each form has a **mode**. Its **state** is computed on every request from the mode, the dates and the current time.

| Mode | State |
|---|---|
| `OPEN` | `OPEN`, or `ENDED` from `closesAt` on (if set). `opensAt` is ignored. |
| `CLOSED` | `CLOSED`. The dates are kept but ignored. |
| `SCHEDULED` | `NOT_YET_OPEN` before `opensAt`; `OPEN` from `opensAt` (inclusive); `ENDED` from `closesAt` on (inclusive). Without `closesAt` it stays open. |

- Only `OPEN` accepts submissions.
- **Saving a schedule:** `SCHEDULED` requires `opensAt`, and its `closesAt` must be after `opensAt` (400 `INVALID_FORM_SCHEDULE`). A form that is `OPEN` or `CLOSED` may keep any dates; they are checked again when it is switched to `SCHEDULED`.
- **Editing or removing a date** takes effect at once: the state is recomputed on the next request. Settings are cached for at most 15 seconds per server, and the server that makes a change drops its cache immediately.

## Time zone

Dates are **stored and exchanged as UTC instants** (ISO 8601). They are **shown in Africa/Kigali time** (UTC+2, no daylight saving). For example, "1 December 2026 at 08:00 in Kigali" is `2026-12-01T06:00:00Z`, which can also be sent as `2026-12-01T08:00:00+02:00`.

Midnight in Kigali is 22:00 UTC the day before. Every public response includes `timezone` and `serverTime`, so pages can show times correctly whatever the visitor's clock says.

## Messages

| Field | Use |
|---|---|
| `closedMessage` | Shown while the form is not open, and returned with a refused submission. When empty, a built-in text is used. For student registration: "Student registration is currently closed. Please contact the Rwanda Olympiad Foundation for further information or check back later." |
| `instructions` | Extra guidance shown with the form, whether open or closed. |
| `contactEmail` | An e-mail address for questions. |
| `supportUrl` | A support page (`https://` only). |

Sending `null` or an empty text restores the built-in message, or removes the other fields.

## API

**Public, no sign-in:**
- `GET /api/v1/forms` and `GET /api/v1/forms/:key` (an unknown key gives 404 `FORM_NOT_FOUND`).
- Response: `{ key, label, open, state, opensAt, closesAt, closedMessage, instructions, contactEmail, supportUrl, timezone, serverTime }`.

**Administrators** (permissions held by Administrators and Super Admins; a Super Admin can deny one to an individual Administrator through a permission override):

| Route | Permission | |
|---|---|---|
| `GET /api/v1/admin/forms`, `GET /api/v1/admin/forms/:key` | `forms.view` | The public fields plus `mode`, `closedMessageCustom`, `closedMessageDefault`, `updatedAt` and `updatedBy`. Teacher registration also gives `requiresTeacherRole` and `teacherRoleEnabled`. |
| `GET /api/v1/admin/forms/:key/history?limit=` | `forms.view` | The form's audit rows, newest first. |
| `PATCH /api/v1/admin/forms/:key/availability` | `forms.manageAvailability` | `{ mode?, opensAt?, closesAt? }`. Partial; `null` removes a date. |
| `PATCH /api/v1/admin/forms/:key/messages` | `forms.editMessages` | `{ closedMessage?, instructions?, contactEmail?, supportUrl? }`. Partial. |

**The old switches** `registration.studentSelfSignup` and `registration.teacherSelfSignup` (`/admin/settings`) are now **views of their forms**, so there are never two switches that can disagree:
- Reading one reports whether the form is open now. This needs `settings.manage`, as before.
- Writing one is a form availability change, under **one authorization rule for every path**:
  - It needs **`forms.manageAvailability`**, checked against the caller's effective permissions, so an individual DENY override applies. This is the same check, with the same refusal (403 `PERMISSION_REQUIRED`, `details: { permission: "forms.manageAvailability" }`), as `PATCH /admin/forms/:key/availability`.
  - The check runs when either key appears in a `PATCH /admin/settings` request, even with the value it already has, and before anything is written. A refused request saves none of its settings.
  - A write is audited as `FORM_AVAILABILITY_CHANGED` (`via: "setting"`, with the request id), never as `UPDATE_SETTING`.
- Writing `true` sets the form to `OPEN` with no closing date; `false` sets it to `CLOSED`. Writing the value it already reports changes nothing.
- Their `SystemSetting` rows are no longer read or written.

## Audit

Every change is one audit row (category `FORMS`), written in the same transaction as the change:
- `FORM_AVAILABILITY_CHANGED`: `changes` (before and after per field), `stateBefore` / `stateAfter`, `via` (`admin` or `setting`) and the request id;
- `FORM_MESSAGES_CHANGED`: `changes` per field and the request id.

The actor and time are on every row. Audit rows cannot be changed or deleted (database trigger).

## Procedure

1. **Close student registration now:** Forms → Student registration → set Closed. Optionally edit the closed message, contact e-mail and support link.
2. **Open at a set time:**
   - set Scheduled, with the opening time (and a closing time if needed) in Kigali time;
   - check the form shows "not yet open" with the right time;
   - at the opening time it opens by itself, with no deployment or restart.
3. **Reopen:** set Open. A past closing date is removed by setting Open with no closing date.
4. **Check:** `GET /api/v1/forms/STUDENT_REGISTRATION` shows the state, and History lists the change with who made it.
