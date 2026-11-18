# Decisions for review (2026-11-18)

Written for: the owner and the reviewer (ChatGPT), to decide what this release needs and what waits.

Source: the 37 questions in `DESIGN-PROPOSALS-V2.md` (full options, alternatives and evidence there) and the 8 carried over
from v1. Nothing here is implemented; each answer below is a recommendation.

Legend — Work: **none** (confirms what is built), **S** (≤ 1 day), **M** (days), **L** (a phase). Flags: 🔒 security,
🧮 data integrity, 🏛 architecture.

## 1. Decide before this release (they touch what this release ships)

| # | Question | Recommendation | Work | Flags | Why now |
|---|---|---|---|---|---|
| 10.1 | Account states: four stored (ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED) + two derived (pending verification / approval) instead of ADR-008's six stored | Accept; show all six as filters | none (filters S) | 🏛 🧮 | migration `20261206000000_account_states` creates the `AccountStatus` enum; changing the model later is another migration on live data |
| 10.2 | "Rejected" as an account state | No — stays on applications | none | 🏛 | same enum |
| 10.3 | Keep DEACTIVATED (separate from SUSPENDED) | Yes | none | 🏛 | same enum |
| 9.2 | Require the close-family (guardian) phone on the server, not only in the form | Yes | S | 🧮 🔒 | today an API client can register a minor without it (`register-student.dto.ts:158`) |
| 9.3 | Date of birth for students created by an Administrator, invited or imported | Optional; asked at the student's first sign-in | none now (prompt S) | 🧮 | self-registration now requires it; the other paths silently do not — confirm that is acceptable for this release |
| 8.3 | Guardian consent for under-16s | Take legal advice before opening student self-registration to the public; if required, record guardian confirmation | none now (M if required) | 🔒 | students are minors; production student self-signup is currently **off**, so this gates switching it on, not the deploy |
| Q11 | Phone numbers unique? | No uniqueness; E.164 (as built) | none | 🧮 | confirms shipped behaviour |
| Q17 | Students change school only through a claim an Administrator verifies; grade by request | As built | none | 🔒 | confirms TS-1 foundation |
| O5 | Head Coaches cannot create coaches without Administrator approval | As built | none | 🔒 | confirms shipped behaviour |

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
