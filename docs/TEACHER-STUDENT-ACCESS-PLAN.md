# Teacher–student association, delegated submission and bulk access management — implementation plan

Owner request 2026-11-17 (Part B). Architecture reviewed before any code. Nothing here is implemented yet; decisions
marked **TS-n** need the owner's answer (recommendation given).

## 1. What already exists (reuse — no parallel system)

| Need | Existing piece | Where |
|---|---|---|
| Teacher's school(s) | `TeacherSchoolAssignment` (Administrators; active / ended; audited) | `src/teachers/teacher-schools.service.ts` |
| "My Students" | `GET /teacher/students` (students.viewScoped): students of the teacher's active schools **whose current school claim is VERIFIED**; name, username, grade, division, school — never contact data | `src/teachers/teacher-students.service.ts`, `AccessService.schoolStudentsFilter`; frontend `/teacher/dashboard`, `/teacher/students/:id` |
| Delegated rights | individual permission overrides (`UserPermissionOverride`, GRANT) of `students.viewProfile`, `students.viewProgress`, `submissions.submitOnBehalf`, granted by Administrators and Super Admins (P1-11), **school scope** (every visible student), soft-revoked, checked on every request | `src/permission-overrides/*`, `/admin/teachers/:id/delegations`; frontend TeacherAccessCard |
| Submit on behalf | `POST /teacher/students/:id/submissions`: the student stays owner; the teacher is `submittedById`, uploader and audit actor | `teacher-students.service.ts#submit` |
| Audit | `AuditLog` (append-only), audit categories | `src/audit/*` |
| Notifications | decision outbox (`permissions.granted` already sent on a grant) and in-app notifications | `src/decision-notifications/*` |
| Bulk infrastructure | `BulkOperation` / `BulkOperationItem`: preview + selection token, idempotency key, per-item results, worker, audit | `src/users/bulk/*`; frontend `/admin/users/bulk` |
| School page | Teachers tab (INT-07, this review) and Students tab | frontend `app/admin/schools/directory/*` |

## 2. What is added

**Database (one additive migration, rollback with data guard):**
- `TeacherStudentAssignment` — teacherId, studentId, `source` (`ADMIN` | `BULK`), isActive, assignedById, createdAt, endedAt,
  endedById; unique (teacherId, studentId) — re-assigning re-activates the row (same pattern as TeacherSchoolAssignment),
  so duplicates are impossible and history is kept. Automatic school association is **not stored** (it is derived from
  the school relationship on each request), so it can never be confused with an explicit assignment.
- `UserPermissionOverride` gains a student scope for the three teacher delegations: `studentScope` `SCHOOL` (today's
  behaviour, the default for existing rows) | `ASSIGNED` (only students explicitly assigned to the teacher) | `SELECTED`
  (only the listed students), and a child table `UserPermissionOverrideStudent` (overrideId, studentId; unique).
  The existing override model, approval list, expiry, revocation and audit are reused — no second permission system.

**Backend:**
- Teacher scope = students of the teacher's active schools (rule TS-1) **∪** students explicitly assigned to the teacher
  (active assignment; cross-school only by an Administrator's explicit assignment, TS-3).
- Delegation check per student: the GRANT applies only if its `studentScope` covers that student (`SCHOOL` → the student is
  in the teacher's school scope; `ASSIGNED` → an active TeacherStudentAssignment; `SELECTED` → listed). Revocation and
  expiry already take effect on the next request (overrides are read fresh).
- Admin API (users.manageTeachers): `GET/POST/DELETE /admin/teacher-students` (one or many students → one teacher; reassign =
  end + assign in one transaction), filters by school / teacher / unassigned; `GET /admin/schools/:id/access` (teachers,
  students, assignments, delegations of a school in one view).
- Bulk: new bulk actions on the existing bulk infrastructure — `assignTeacherStudents`, `unassignTeacherStudents`,
  `grantDelegation`, `revokeDelegation` — with preview, confirmation token, idempotency key, per-item results (duplicates
  reported as SKIPPED "already assigned / already granted"), audit.
- Teachers never get users.manageTeachers or permissions.manageOverrides: they cannot assign or grant (existing guard).

**Frontend:**
- Teacher: My Students lists school students and assigned students with a "source" badge (school / assigned) and a
  "can submit for" badge; search and filters; submit-on-behalf shows "Submitting for <student>".
- Administrator: **School access** page (`/admin/schools/:id/access`): teachers and students side by side with checkboxes,
  select-all, filters (grade, assigned / unassigned), actions *Assign to teacher(s)*, *Remove*, *Grant submission
  permission* (selected students / all assigned / whole school), *Revoke*; a confirmation summary; results with partial
  failures; records needing attention (students without a teacher, delegations on ended assignments).
  Teacher user page: assignments and delegation scope.

**Audit / notifications:** TEACHER_STUDENT_ASSIGNED / _UNASSIGNED / _REASSIGNED, DELEGATION_GRANTED / _CHANGED / _REVOKED
(previous and new scope), bulk operation rows, on-behalf submissions (exists). The teacher receives the existing
`permissions.granted` notice; an in-app notice on assignment (TS-6).

## 3. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| **TS-1** | Which students does a teacher see automatically? Today: only students whose school claim an Administrator has **verified** (your rule: "email verification does not establish school membership"). Your new text says students who **registered with the school code**. | Keep **verified** claims for automatic visibility; show the teacher a count of students "pending school verification" (no names) so they can ask an Administrator to verify. Alternative: also list pending students (names only). |
| TS-2 | May a student have several teachers? | Yes (several teachers of one school; the assignment table allows it). |
| TS-3 | Cross-school: may an Administrator assign a student of another school to a teacher? | Yes, only explicitly, audited; the teacher sees that student while the assignment is active. |
| TS-4 | Keep the existing school-wide delegation scope? | Yes, as one of three scopes (school / assigned / selected); existing grants stay school-wide. |
| TS-5 | When an assignment ends, does a `SELECTED` delegation for that student stop? | It stays recorded but has no effect while the student is outside the teacher's scope; flagged as "needs attention". |
| TS-6 | Notify the teacher on assignment (in-app) and on grants (e-mail + in-app, existing)? Notify students? | Teacher: yes. Students: no (minors; avoid unnecessary messages). |

## 4. Order of work

1. Migration + model + scope rules (backend) with unit and e2e tests (PostgreSQL).
2. Admin API individual + bulk actions with e2e tests (authorization, duplicates, partial failures, retries, audit).
3. Frontend: My Students update, School access page, teacher user page; unit tests.
4. Playwright: scenarios 1–20 of the request and the extra cases.
5. Release kit, docs, matrix.
Steps 1–4 for parts not affected by TS-1…TS-6 start right away; the visibility rule waits for TS-1.
