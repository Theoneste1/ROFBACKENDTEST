# Coaches across their programmes (owner decision 2026-11-23)

Every Coach automatically has four kinds of access in each programme (subject) they belong to. Each applies at **every
level** (Junior, Middle, Senior and any level added later):

| Part | What the coach can do | Where |
|---|---|---|
| `STUDENTS` | See the programme's students (name, level, grade, school, subjects; never contact details) | `GET /coach/students`; the student overview |
| `COURSES` | Open and manage every course of the programme, at every level it is offered in (resources, assignments, discussions, analytics) | `AccessService.courseScopes / hasCourseScope` |
| `MARKING` | Mark the subject's tests without a separate authorisation | `src/test-management/marker-reach.ts` |
| `RESULTS` | See the subject's **published** results by name (never a rank, unpublished mark, submission code or marker) | `GET /coach/test-results…` |

A coach in Physics sees only Physics.

Some rules stay the same:
- Head Coaches keep their existing rules.
- Homework grading is still handed out only to coaches explicitly assigned to that course and level.
- Test marking stays blind, and a coach still marks only the answers handed to them.

## Taking a part away

An Administrator (any programme) or the programme's Head Coach (only programmes they head) can take any part away from
one coach in one programme. A reason is required. They can give it back later:
- `GET /admin/coaches/:id/programme-access`
- `PUT /admin/coaches/:id/programme-access`, with body `{ programmeId, capability, allowed, reason? }`

Each removal is stored as a `CoachProgrammeRestriction` row. At most one is active per coach, programme and part, which
the database enforces with a partial unique index. Every change is audited (`COACH_PROGRAMME_ACCESS_REMOVED` and
`COACH_PROGRAMME_ACCESS_RESTORED`). Lifted rows are kept as history.

Marking interacts with the existing authorisation screen as follows:
- **Revoking** a coach's marker authorisation also records a `MARKING` removal when the coach is a programme member.
  Otherwise they would keep marking through the programme default.
- **Authorising** a coach lifts any `MARKING` removal.
- A removal blocks **both** paths, so "taken away" always means the coach no longer marks that subject.

**Migration** `20261227000000_coach_programme_access` (additive):
- creates the `CoachCapability` type and the `CoachProgrammeRestriction` table;
- **carries over** every marking authorisation revoked before this release, with its reason and the person who revoked
  it, so the new default does not hand marking back to coaches it was deliberately taken from.

The rollback is `docs/migrations/20261227000000_coach_programme_access.rollback.sql`. It refuses to run while restrictions
recorded after the release exist, unless that is explicitly allowed.

**Permissions** `students.viewProgramme` and `tests.viewProgrammeResults` are granted to every Coach with `programme`
scope. **Capability** `coachProgrammeAccess`.
