# Verifying students' school claims (after the Phase 1 release)

## What the release does

Migration M9 (`20261121000800_student_school_affiliation`) gives every existing student one school
claim, source `MIGRATION`, status **PENDING**:

- a student linked to a school → a PENDING claim **for that school**;
- a student with only a free-text school name → a PENDING claim **without a school** (name only).

Nobody becomes VERIFIED automatically, and there is **no bulk approval** (no endpoint, script or
migration verifies claims in bulk). This is deliberate: a claim says "this student says they attend
this school"; only an administrator confirms it.

Until a claim is VERIFIED:

- the student's account, courses, assignments and results work normally;
- the student is **not counted** on the school leaderboard (it counts only VERIFIED claims, so right
  after the release it is empty in every division);
- a Teacher assigned to that school does **not** see the student.

## Who can do it

Anyone holding `schools.manage`: Administrators and Super Administrators. Each action is audited
with the administrator's identity.

## Workflow (Administrator)

Open **Admin → Schools → School verification** (`/admin/schools/affiliations`). The list defaults to
**Waiting** (PENDING); the Status filter also shows Verified, Rejected and Revoked.

For each waiting claim:

1. **Claim has a school** → check it against your own records (enrolment list, the school's
   confirmation, the coach's knowledge). Then:
   - **Verify** (optional note) — the student counts for that school from the next request; or
   - **Reject** with a reason (3–500 characters, **shown to the student**).
2. **Claim has only a name** (school not listed, or abroad) → **Match to a school** first. The
   dialog suggests schools with the same normalised name in the same country/district; if the
   school is missing, create it under **Schools → Directory**, then match. A different country is
   refused; a different province/district/sector needs an explicit confirmation. Matching leaves the
   claim PENDING — then verify or reject as in 1.
3. Mistakes are reversible:
   - **Revoke** a verification (reason required, shown to the student) — takes effect on the next request;
   - **Reopen** a rejected or revoked claim (reason required) — it becomes a new PENDING claim.

A student's full claim history is available from the API (`GET /admin/users/:id/school-affiliations`);
the admin site does not show it yet.

Students see their own claim status, and the reason when rejected or revoked, on their profile page.

## Suggested order after the release

1. Schools whose students take part in the school leaderboard or have a Teacher planned.
2. Name-only claims (they need matching, so they take longer).
3. The rest, in batches per school (filter by school in the API, `?schoolId=`).

## API reference

All under `/api/v1/admin`, permission `schools.manage`:

| Action | Request |
|---|---|
| List | `GET school-affiliations?status=PENDING&schoolId=&studentId=&country=&hasSchool=&page=&limit=` (`hasSchool=false`: the name-only claims to match) |
| One claim | `GET school-affiliations/:id` |
| Verify | `POST school-affiliations/:id/verify` `{ "note"?: string }` |
| Reject | `POST school-affiliations/:id/reject` `{ "reason": string }` |
| Revoke | `POST school-affiliations/:id/revoke` `{ "reason": string }` |
| Match candidates | `GET school-affiliations/:id/candidates` |
| Match | `POST school-affiliations/:id/match` (see docs/API.md) |
| Reopen | `POST school-affiliations/:id/reopen` `{ "reason": string }` |
| Student history | `GET users/:id/school-affiliations` |
