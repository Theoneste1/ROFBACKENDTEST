# Registration data (owner request 2026-11-23)

Super Administrators can see, filter, sort, export and edit everything people entered when they registered. Every
field comes from the database, through an explicit eligibility layer. There is no hand-written list of columns, filters
or edit fields, so a registration field added later appears on its own.

## Who can use it

- The permission `registrationData.manage` is held by Super Administrators only. It is **never grantable**: an
  individual override cannot give it to anyone else.
- Administrators, Head Coaches, Coaches, Teachers and Students get 403; signed-out callers get 401. Every route
  is listed in `route-access-additions.testing.ts`.
- Capability flag: `registrationData`. The frontend menu entry also needs the known permission.

## Where the data comes from

| Source key | Table | What it holds | Edited here |
|---|---|---|---|
| `user` | `User` | the account: names, e-mail, username, phone, country, gender, date of birth, guardian phone, home place, grade, school, Olympiad level, interests, status, dates | yes (see below) |
| `coachApplication` | `MentorRequest` | occupation, education level, affiliation, expertise, experience, years | yes |
| `teacherApplication` | `TeacherApplication` | position, years of teaching, the school as entered, an unlisted school's details | yes |
| `schoolClaim` | `StudentSchoolAffiliation` (current claim) | the school as the student typed it | no (verification workflow) |
| `school` | `School` (via `User.schoolId`) | the school's code, province, district, sector, … | no (lookup) |
| `division` | `Division` (via `User.divisionId`) | the Olympiad level's name and code | no (lookup) |

Categories (tabs) and their sources:

| Category | Sources |
|---|---|
| Students | `user`, `school`, `division`, `schoolClaim` |
| Teachers | `user`, `teacherApplication` |
| Coaches | `user`, `coachApplication` |
| Head Coaches | `user`, `coachApplication` |
| Administrators | `user` |
| All users | `user`, `school` |

Student-only account columns (grade, Olympiad level, school, date of birth, guardian phone) are offered only for
Students and All users.

The coach application had no link to its account. Migration `20261226000000_registration_data` adds
`MentorRequest.userId` and fills it for earlier approvals:
1. From each approval's own audit entry (`APPROVE_MENTOR_REQUEST`, `metadata.newUserId`). This match is exact.
2. Failing that, from a unique e-mail match against a Coach or Head Coach.

Approvals set the link from now on.

## The catalogue: read from the database

`FieldCatalogueService` reads `information_schema.columns`, foreign keys and `pg_enum` for the six tables above. It
keeps a column only when the application's data model also knows it (Prisma's `<Model>ScalarFieldEnum`), so a
column added to the database before the code that understands it is deployed stays out. The result is cached for
60 seconds. Types are mapped as follows:
- text → text;
- integer and numeric → number;
- date → date;
- timestamp → date-time;
- boolean → yes/no;
- enum → choice, with values from `pg_enum`;
- enum array → list of choices;
- text array → list.

JSON and binary columns are never offered.

## The eligibility layer (`src/registration-data/field-policy.ts`)

Rules decide what every column may do. They are matched by name as well as listed, so they apply to columns that don't
exist yet.

1. **Never exposed:** security data, matched by name (`password`, `hash`, `token`, `secret`, `salt`, `otp`, `mfa`,
   `apikey`, `recovery`, `provider`, `failedLogin`, `lockedUntil`, …), in every table.
2. **Not shown:** internal plumbing.
   - Foreign keys are hidden. A person sees the school's or level's name instead; the only raw key shown is the
     school's ISO country code.
   - Also hidden: files, cached leaderboard totals, and an application's copy of an account column. The account is
     the record that is kept up to date.
3. **Read-only:** ids, creation and update times, last sign-in, activation, approval, and application decisions. The
   school claim and the lookup tables are read-only too.
4. **Edited through the existing rules** (`editVia: "account"`, using `UsersService.update` in the same transaction):
   - names, e-mail and username: uniqueness is checked, and a new e-mail revokes links already e-mailed;
   - role: a step-up password is needed to or from an Administrator role, sessions end, and scopes and assignments
     end;
   - grade: the Olympiad level follows the grade unless the level was set by hand;
   - school: the school claim moves and the enrolment follows;
   - gender;
   - home country and place: Rwanda's official places only;
   - Olympiad interests: canonical order; editable for every role here.
5. **Their own action, with a reason:**
   - account status: `POST /admin/users/:id/status-changes`;
   - date of birth: `PUT /admin/users/:id/date-of-birth`;
   - Olympiad level: `PUT /admin/students/:id/olympiad-level`.

   The record says what to do instead of offering an input.
6. **Personal data** (phones, date of birth, guardian, home place, address, national id, by name) is shown and
   exported to Super Administrators. Its **values are never written to the audit log**: the entry records that the
   field changed, by whom and when.
7. **Anything else** (a new plain column) can be viewed, filtered, sorted and exported, and edited when it is plain
   text, a number, a date, yes/no or a choice. The checks depend on the type:
   - phone-like names must be E.164;
   - e-mail-like names must be a valid address;
   - country-like names must be ISO alpha-2;
   - `years…` must be between 0 and 80;
   - the length limit is the column's own.

   Database `CHECK` constraints are the backstop.

Passwords are never shown. The record has "Send password-reset link", which uses the existing
`POST /admin/users/:id/send-password-reset`.

## API (`/api/v1/admin/registration-data`)

| Route | Purpose |
|---|---|
| `GET /fields?category=` | the category's fields (type, choices, labels, personal, how edited, conditions) and the default columns |
| `POST /query?page&limit` | one page (≤ 200 rows): `{ category, columns, filter?, sort?, search? }` |
| `POST /export?format=csv\|xlsx` | the same body: every matching row (≤ 200,000), the chosen columns in order, streamed, audited |
| `GET /users/:id` | one record: every field of the account's category, its value, editable or a note saying why not |
| `PATCH /users/:id` | `{ changes: { "<field key>": value }, version?, currentPassword? }`: all checks first, one transaction, audited |
| `GET / POST /saved-filters`, `PUT / DELETE /saved-filters/:id` | saved filters: owner-only changes; can be shared with the other Super Administrators to use |
| `GET / PUT / DELETE /layouts/:category` | the caller's columns per category (stored in `TableLayout` as `registration.<CATEGORY>`) |

**Filter tree.** A group is `{ combinator: "AND" | "OR", conditions: [...] }`. Groups nest at most 4 levels deep and
hold at most 50 conditions. A condition is `{ field, operator, value?, value2? }`. Operators by type:

| Type | Operators |
|---|---|
| text | `contains`, `notContains`, `eq`, `neq`, `startsWith` |
| number | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between` |
| date and date-time | `on`, `before`, `after`, `between` (days in Kigali time) |
| yes/no | `isTrue`, `isFalse` |
| choice | `in`, `notIn` |
| list | `hasAny`, `hasAll`, `hasNone` |
| every type | `isEmpty`, `isNotEmpty` |

"Is not", "does not contain" and "none of" also match empty values.

**Safety.**
- Fields are named by catalogue key, and every key, operator and value is checked against the catalogue.
- Values are parsed to the column's type, and everything becomes a Prisma `where` with bound parameters. No request
  text reaches SQL.
- Problems come back together as `400 INVALID_QUERY` / `INVALID_VALUES`, in plain words, with `details.problems`.
- Other errors:
  - `409 RECORD_CHANGED`: someone changed the record after it was opened;
  - `409 NO_APPLICATION_RECORD`: an account created by an administrator has no application;
  - `422 EXPORT_TOO_LARGE`.

**Audit actions.**
- `REGISTRATION_DATA_UPDATED` records each field's old and new value (personal values are masked) and which fields
  went through the account rules. Those rules also write their own entries.
- `REGISTRATION_DATA_EXPORTED` records the category, format, row count, columns, personal columns and whether the
  export was filtered.

## Frontend (`/admin/registration-data`)

- **Navigation:** category tabs and a search box over name, e-mail and username.
- **Columns dialog:** every field, grouped, with a "personal" badge. Columns can be shown or hidden and reordered,
  then saved for the category or used without saving. Defaults and "forget my columns" are available.
- **Filter builder:** add conditions and groups, choose all (AND) or any (OR), and get values and conditions by field
  type. The filter is checked before it is sent.
- **Saved filters:** save, share, reopen, change, save as new, delete.
- **Table:** sorting and paging are done by the server, with a choice of rows per page.
- **Export:** CSV and Excel, exactly the shown columns, every matching row.
- **Record editor:** every field grouped. Inputs match each type, with a school picker for the school. Non-editable
  fields say what to do instead. Problems are shown next to their fields. The editor asks for your own password for
  Administrator role changes and offers a password-reset link.

## Rollback

`docs/migrations/20261226000000_registration_data.rollback.sql` drops `MentorRequest.userId` and the
`RegistrationSavedFilter` table. It refuses while saved filters exist unless the session sets
`rof.registration_data_rollback = 'discard-saved-filters'`. It changes no account or application value.

## Test results

See the pull request description for the exact numbers of the run on the pushed commit.
