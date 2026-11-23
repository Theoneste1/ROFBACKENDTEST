# ROF LMS — reconciled final scope and implementation plan (2026-11-17)

Reconciles the 102 requirements (`docs/REQUIREMENTS-MATRIX.md`) with every recorded decision:
`ARCHITECTURE_DECISIONS.md` (ADR-001…019, "approved design direction", 2026-11-08, amended 2026-11-09), the Phase 1
decision register (`docs/PHASE-1-PLAN.md` §2, owner sign-off 2026-11-09), and later owner decisions recorded in
merged pull requests (P1-11 school-based teacher scope 2026-11-10; teacher course grants removed 2026-11-14; school
directory S1–S3; account states, bulk operations, form availability 2026-11-15/16).

## 1. Classification rules

| Class | Meaning | Action |
|---|---|---|
| **A — Approved, implementable** | Covered by an approved ADR or owner decision with no open question | implement now |
| **B — Approved direction, needs design approval** | ADR approved, but open questions (Q3…Q21) or UX/model choices remain | design in `docs/DESIGN-PROPOSALS.md`; implement after approval |
| **C — Deferred by the owner** | Explicitly deferred in the register | not counted as missing; listed for a future decision |
| **D — Excluded by the owner** | Explicitly not wanted | not implemented |
| **Done** | Implemented and tested | keep as regression |

## 2. Explicitly deferred or excluded (C, D)

| Item | Decision | Source |
|---|---|---|
| Custom permission profiles created by administrators (PERM-02) | **C** deferred | ADR-004 amendment, D3 (2026-11-09) |
| Organisational role (part of PERM-01; Q5) | **C** deferred out of Phase 1 | D5 |
| Head Coach discussion moderation | **C** deferred until designed with communication features | H7 (changed at sign-off) |
| Multi-factor authentication | **C** deferred | S3 |
| Coach–student supervision links | **C** deferred | register |
| Head Coaches creating coaches without Administrator approval | open (O5), today: approval required | register |
| Several user types per person | open (Q9/O6), today: one type | register |
| Private one-to-one messaging | **D** excluded in release 1 ("to be reconsidered later") | ADR-013 |
| E-mail read receipts for minors | **D** not recommended (Q18) — needs confirmation | Q18 |
| Teacher course × division access | **D** removed (teachers are school-scoped; no course access) | owner decision 2026-11-14 |
| Old "study groups" module | superseded: ADR-013 (2026-11-08) approves communication groups and says to **reuse** it; the 2026-11-03 switch-off is not an exclusion of groups | ADR-013 |

Teacher **content contribution** (materials and assignments submitted for approval, ADR-003) is not excluded: it
was moved to Phase 7 ("teacher resource submission (Phase 7)") and depends on the publishing workflow (B).

## 3. Final scope per requirement

`Done` / `A` / `B` / `C`. The 48 "Done" items (46 complete + 2 gated by flags) keep their regression tests. "Done*" = done on an open branch.

| Area | Done | A — implement now | B — design approval needed | C/D |
|---|---|---|---|---|
| Registration | REG-01, 07, 08*, 11, 12*, 14 | **REG-05** teacher position + years of experience; **REG-06** coach phone, affiliation, expertise, experience; **REG-10** request-more-information step (ADR-009); **REG-02** profile picture at sign-up; **REG-13** registration history (per-user timeline from existing records) | REG-02 country grades (with Phase 2); **REG-09** configurable fields (Q10); REG-03, REG-04 (Phases 2, 6) | — |
| Countries / schools | INT-04, 05, 08, 09 | **INT-07** teachers of a school on the school page | **INT-01, 02, 03** (ADR-005; Q12, Q13, Q15); **INT-06** school administrators (Q14) | — |
| Subjects / topics | SUB-07 | — | **SUB-01…06** (ADR-007; Q3) | programme creation was deferred to Phase 3 → included in SUB design |
| Academic / courses | ACA-01, 04 | — | **ACA-02, 03, 05**, REG-04 (ADR-006) | — |
| Accounts | ACC-01…11, 13, 15 | **ACC-16** field-level masking of guardian / student phones for non-permitted readers | **ACC-12** explicit PENDING / REJECTED states (ADR-008 vs the four stored states); **ACC-14** retention-based deletion (Q16) | — |
| Permissions | PERM-03, 05, 06, 07, 08 | — | PERM-04 country / group / support scopes (arrive with their features) | PERM-01 org role, PERM-02 (C) |
| Publishing | — | — | **PUB-01…04** (ADR-010/011; Q7); teacher content submission | — |
| Student support | — | — | **SUP-01…06** (ADR-012; Q8) | — |
| Groups / e-mail | — | — | **GRP-01…05** (ADR-013/014) | private messaging (D) |
| Notifications | NOT-02…06 | — | NOT-01 topics of the new features (with each feature) | — |
| Admin / UX | ADM-02, UX-01 | — | ADM-01 (completes with the phases) | — |
| Students / teachers | TCH-01 | — | STU-01 (completes with the phases) | — |
| Security / privacy | SEC-01, 05, 06 | **SEC-02** restore drill (needs a Neon branch); **SEC-03** what is possible now: guardian phone masking (with ACC-16) | **SEC-04** retention, export, erasure (Q16); SEC-03 guardian consent | — |
| Architecture | ARC-01, 02, 03 | — | **ARC-04** staging (ADR-016: needs owner-created Neon branch + Render service) | — |
| Audit | AUD-01, 03 | **AUD-02** before/after values on the remaining audited actions | AUD-04 (with each feature) | — |
| Performance / UI | PERF-01 | **PERF-03** accessibility checks in the browser e2e suite | PERF-02 resumable uploads (decision: needed?) | — |

## 4. Implementation plan

Order: approved work first, while the designs are reviewed. Every step: development branch from `develop`,
migrations additive with rollback files and rehearsal-kit entries, backend e2e on PostgreSQL, frontend unit tests,
browser e2e for the user-facing flow, docs regenerated, PR to `develop`. Nothing reaches `main` or production
without approval.

| # | Workstream | Class | Contents | Depends on |
|---|---|---|---|---|
| W0 | **Test infrastructure** | A | real PostgreSQL locally (or CI on every branch), browser e2e (Playwright) for both repos running frontend + backend + PostgreSQL together; seeded synthetic data for all seven roles | permission to run a local PostgreSQL server, or CI on push |
| W1 | **Applications complete** | A | migration: TeacherApplication `position`, `yearsOfExperience`; MentorRequest `phone`, `affiliation`, `expertise`, `relevantExperience`, `yearsOfExperience`; INFO_REQUESTED state for both, with the administrator's question, a secure 14-day response link e-mailed to the applicant, the applicant's answer, history; frontend forms, review screens, response page; e2e + browser e2e | W0 for browser tests |
| W2 | **Registration remainder** | A | profile picture at sign-up (optional, after the account exists via the activation flow); registration timeline on the user page (application, decision, activation, state changes) | W1 |
| W3 | **School page: teachers** | A | teachers assigned to the school on `/admin/schools/:id` | — |
| W4 | **Sensitive data** | A | guardian / student phone visible only to users.manageStudents in scope; audited before/after values on remaining actions | — |
| W5 | **Restore drill + staging** | A | restore the new production dump into a Neon branch; staging = Neon branch + second Render service + Netlify branch deploy | owner creates the Neon branch / Render service |
| W6 | Phase 2 countries and education systems | B | Design D1 | approval |
| W7 | Phase 3 subjects, topics, programmes | B | Design D2 | approval (and W6 for availability per country) |
| W8 | Phase 6 course access and enrollment | B | Design D3 | approval |
| W9 | Phase 7 publishing, revisions, teacher contributions | B | Design D4 | approval, W7 |
| W10 | Phase 8 student support portal | B | Design D5 | approval |
| W11 | Phase 9 groups and targeted e-mail | B | Design D6 | approval, W6/W7 (audiences) |
| W12 | Phase 10 privacy and account states | B | Design D7 (+ ADR-008 states) | approval |
| W13 | Configurable registration fields | B | Design D8 | approval, W1 |
| W14 | Final verification | — | full browser e2e for every role, requirements matrix with evidence per row, release rehearsal of all migrations on a production branch | all |

**Release policy (owner, 2026-11-17):** no further partial releases while agreed scope is unfinished. Production
receives the complete, verified product in one approved release (W14), unless the owner decides otherwise.

## 5. Scope reductions and delivery priority (owner, 2026-11-19)

Approved by the owner on 2026-11-19 after an impact assessment. No code, data or database table is removed by these
decisions; nothing approved or existing breaks.

| Area | Decision | Effect |
|---|---|---|
| 7 Targeted e-mail (W11, part) | Not a standalone feature: **Bulk Actions messaging is the one messaging capability** | GRP-05 re-scoped: role and school audiences exist; **country filter added with Bulk Actions**; **subject filter with Area 2**; group audience deferred with Area 6; no saved audiences. EmailJob / EmailDelivery, delivery logs, retries and failed-delivery screens stay. `POST /admin/email/send` and its composer keep working (not removed or broken). Inactive-account handling of the old composer is verified before any future consolidation. GRP-05 is complete only when the country and subject filters exist. |
| 5 Student support portal (W10) | **Deferred** (SUP-01…06) | The public contact form, the support information page, Admin → Messages and notifications stay. No tickets, internal notes, configurable statuses or coach meeting requests now. |
| 6 Groups (W11, part) | **Deferred** (GRP-01…04 and group administration) | Programme memberships, coach–student, teacher–school and teacher–student relationships, coach assignments and course discussions unchanged. The study-groups code and tables are kept (module not registered). Group scope removed from SUB-06 and PERM-04 only; subject and course permissions kept. |
| 10 Account states (W12, part) | **Closed as built** | Four stored states (ACTIVE, DEACTIVATED, SUSPENDED, ARCHIVED) and two derived conditions (not activated, pending approval); REJECTED stays on applications. No new stored states; no combined state badge. ACC-12 stays complete and verified. |

**Delivery priority (replaces the order of W6–W13):**

| # | Work | Notes |
|---|---|---|
| 1 | Sign-up redesign (Student, Teacher, Coach): one screen per step | in progress |
| 2 | Bulk Actions: backend (engine, user relationships, administration, content), then frontend | in progress; includes the country filter |
| 3 | Test submission, marking, approval and publishing | plan approved 2026-11-19; 4 phases, backend then frontend PR each |
| 4 | Area 2 subjects and topics (W7) | coordinated with test management so Physics and Computing are supported properly; adds the subject filter to Bulk Actions messaging |
| 5 | Area 3 enrolment and access (W8) | |
| 6 | Area 4 publishing and versioning (W9) | |
| 7 | Area 8 privacy and retention (W12 without account states) | |
| 8 | Area 9 configurable registration fields (W13) | after the sign-up redesign |

Area 1 (countries, W6) is complete. W14 (final verification and one approved release) is unchanged.
