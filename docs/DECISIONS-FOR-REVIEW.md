# Decisions for review (2026-11-18)

Written for: the owner and the reviewer (ChatGPT), to decide what this release needs and what waits.

Source: the 37 questions in `DESIGN-PROPOSALS-V2.md` (full options, alternatives and evidence there) and the 8 carried over
from v1.

**Status 2026-11-18 (later the same day): the owner approved every recommendation in §1, including SR-1 and SR-2.** The
"Status" column records what was built and the evidence. §2–§4 are still recommendations only — nothing there is built.

Legend — Work: **none** (confirms what is built), **S** (≤ 1 day), **M** (days), **L** (a phase). Flags: 🔒 security,
🧮 data integrity, 🏛 architecture.

## 1. Decide before this release (they touch what this release ships) — APPROVED 2026-11-18

| # | Question | Approved | Status and evidence |
|---|---|---|---|
| 10.1 | Account states: four stored (ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED) + two derived (pending verification / approval) | Yes | **Confirmed as built** (no change): `AccountStatus` enum of four (migration `20261206000000_account_states`); pending verification / approval derived from `activatedAt` / `isApproved`. Tests: e2e account-states (already in CI). The six-state *filters* in the user list are a later small item (not built). |
| 10.2 | "Rejected" stays an application state, not an account state | Yes | **Confirmed as built** (no change): `AccountStatus` has no REJECTED; a rejection is recorded on the application (TeacherApplicationStatus / MentorRequestStatus). |
| 10.3 | DEACTIVATED stays distinct from SUSPENDED | Yes | **Confirmed as built** (no change): separate states, transitions and permissions (`users.changeStatus` vs `users.suspend`). |
| 9.2 | Guardian (close-family) phone required by the server | Yes | **Implemented and tested** — backend #62 `c920d92`: `guardianPhone` required on `POST /auth/register/student` (the only student sign-up path); missing, null, empty, blank, malformed or invalid → 400 naming the field, nothing created; E.164 storage unchanged; own phone optional. e2e registration-details (9 refused values + valid), unit DTO. Staff-created students are not registration and are unaffected. Frontend form already required it (no change). |
| 9.3 | DOB optional for staff-created / invited / imported students; asked at first sign-in | Yes | **Implemented and tested** — backend #62 `c920d92` (`DateOfBirthGuard`, `PUT /me/date-of-birth`, `dateOfBirthRequired` on login and `GET /me`, capability `studentDateOfBirthStep`); frontend #36 `31097e4` (the student portal shows only the date-of-birth step until it is given). e2e date-of-birth-step: admin-created, invited, imported students held then released; self-registered and seeded students and other roles never held; invalid dates refused; given once (409); audited without the value. **Release note:** production students registered before the date of birth was required have none and will be asked once at their next sign-in (intended; not measured on production — read-only access was not used for this). |
| 8.3 | Guardian consent for under-16s | Yes (legal advice before opening student self-registration) | **No build now**: production student self-signup stays off; gates switching it on, not this release. |
| Q11 | Phone numbers need not be unique | Yes | **Confirmed as built** (no uniqueness constraint; E.164). |
| Q17 | School changes only through an Administrator-verified claim | Yes | **Confirmed as built** (school claims; TS-1). |
| O5 | Head Coaches cannot create Coaches without Administrator approval | Yes | **Confirmed as built**: a Head Coach holds neither `users.manage` (creating accounts) nor `mentorRequests.decide` (approving coach applications); they only add existing coaches to their programme (`programmes.manageMembers`). Sweep: Head Coach reaches exactly 15 programme-scoped /admin routes. |

**From the security review of teacher–student access (2026-11-18) — APPROVED:**

| # | Approved | Status and evidence |
|---|---|---|
| SR-1 | Teachers never see SUSPENDED, DEACTIVATED or ARCHIVED students | **Implemented and tested** — backend #63 `14b9e1a`: the ACTIVE condition is on both visibility rules (school and assignment, cross-school included) and so on every teacher path (list with every filter, summary, profile, progress, delegation coverage, submit on behalf, new SELECTED delegations, bulk grants). Scope is kept separate: hiding does not end assignments or drop selected students, and does not change how a new assignment is classified; reactivation restores access. Administrators still see and manage them. e2e: 3 states × school and cross-school student × every route; fails without the fix (checked). |
| SR-2 | Pending-claim students may be assigned explicitly, with a reason, audited, visible to that teacher only | **Confirmed as built, test added** — backend #63 `14b9e1a`: without a reason REASON_REQUIRED; the assignment records the reason, `crossSchool`, the Administrator; audit TEACHER_STUDENT_ASSIGNED; the teacher sees that one student (`assigned`, not `school`), other teachers of the school do not. |

**Not a product decision but needed before release:** a staging / rehearsal target (ARC-04) is optional now — the
migrations were rehearsed on a restored copy of production (see `FINAL-REVIEW-PACKAGE.md` §5).

## 2. Can safely wait (later phases; nothing in this release depends on them)

| Area | Questions | Recommendation summary | Work if approved | Flags |
|---|---|---|---|---|
| 1 Countries / education systems | 1.1–1.4 | all ISO countries inactive by default; one optional region level; one global academic year; no primary pupils in release 1 | L (Phase 2) | 🏛 (1.3 global year) |
| 2 Subjects / topics | 2.1–2.4 | one topic per course; subject = programme 1:1; interests map to subjects; Administrators create courses | L (Phase 3) | 🏛 (2.2) |
| 3 Course access | 3.1–3.3 | new courses ENROLLMENT_REQUIRED; Head Coaches enroll in their programme; no student requests at first | L (Phase 6) | 🔒 🧮 (3.1 must not remove current students' access — existing courses keep today's policy) |
| 4 Publishing | 4.1–4.5 | changes-requested ≠ rejected; teacher content always approved; teachers contribute for their school(s) / subject(s); Admins + programme Head Coach approve; teachers see titles only | L (Phase 7) | 🔒 (4.4, 4.5) |
| 5 Support portal | 5.1–5.3 | proposed times + confirmation; fixed statuses; students open requests first | L (Phase 8) | 🔒 (minors' messages) |
| 6 Groups | 6.1–6.4 | moderated student discussions; Head Coach moderates only where appointed; no student moderators; members see name and role only | L (Phase 9, reuse study-groups per ADR-013) | 🔒 (minors) |
| 7 Targeted e-mail | 7.1–7.3 | group administrators for their own group only; no saved audiences; in-app copy | M (Phase 9) | 🔒 (7.1 who may send) |
| 8 Privacy | 8.1, 8.2, 8.4, 8.5 | 3-year retention after archive; Super Admin exports / erases; no read receipts; keep technical retention | M–L (Phase 10) | 🔒 🧮 |
| 9 Registration fields | 9.1 | configurable optional fields (listed) | M | 🧮 |
| Cross-cutting | Q9, Q14, Q19, PERF-02 | one user type per account; school contacts (no school-admin accounts); current password policy; no resumable uploads | none / later | 🏛 (Q9) |

## 3. Decisions that require additional implementation if approved

Small (can follow this release quickly): 9.2 server-side guardian phone, 9.3 first-sign-in DOB prompt, 10.1 six-state
filters. Medium: 7.x targeted e-mail, 9.1 configurable fields, 8.x privacy tooling. Large (each a phase with its own
migration and tests): areas 1–6.

## 4. Decisions with security, data-integrity or architectural implications

- 🔒 Minors: 8.3 (consent), 6.1/6.3/6.4 (group visibility and moderation), 5.x (support messages), 9.2 (guardian contact).
- 🔒 Who may act: 4.4 (approvers), 4.5 (teacher content visibility), 7.1 (who may e-mail), 8.2 (export / erasure), O5.
- 🧮 Data: 10.x (account-state model), 3.1 (course access policy for existing courses), 8.1 (retention / deletion), 9.2, 9.3, Q11.
- 🏛 Architecture: 10.x, 2.2 (subject = programme), 1.3 (academic years), Q9 (several user types per account).

## Teacher–student access

No open decisions: TS-1…TS-6 were approved on 2026-11-18 and are implemented as approved.
