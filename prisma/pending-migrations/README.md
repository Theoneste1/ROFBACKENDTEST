# Pending migrations (require approval)

Migrations here are **not** applied by `prisma migrate deploy` — Prisma only
reads `prisma/migrations/`. They are destructive and wait for explicit
approval.

## 20261105000000_drop_superseded_columns

**What it does.** Drops the columns superseded by the
`20261104000000_academic_structure_reviews_moderation` migration:

| Table | Columns dropped | Data now lives in |
|---|---|---|
| Submission | mentorId, score, percentage, mentorFeedback, feedbackFileId, coordinationNote, rejectionReason, previousScore, reopenNote, reopenedAt, reopenedById, assignedAt, reviewStartedAt, markedAt, submittedToAdminAt, approvedAt | MentorReview (+ ReviewEvent, ReviewAttachment) |
| Submission, SubmissionRevision | fileId | SubmissionAttachment |
| CourseResource | fileId | ResourceAttachment |
| Assignment | fileId | AssignmentAttachment |
| Comment | courseId, assignmentId, divisionId | DiscussionThread |
| Comment | moderatedAt, moderatedById | ModerationAction |

**Impact.**
- No information is lost: the expand migration copied every value into the new
  tables, and this script verifies that before dropping anything (it aborts
  and changes nothing otherwise).
- The application already ignores these columns, so behaviour does not change.
- Irreversible: once dropped, the old columns can only be restored from a
  backup.

**Procedure (after approval).**

1. Take a database backup.
2. Move the folder into `prisma/migrations/`.
3. In `prisma/schema.prisma`, delete every field marked `@deprecated` (and the
   matching back-relations on `User`, `FileObject`, `Course`, `Assignment`,
   `Division`), then run `npx prisma generate`.
4. `npm run db:migrate` (production) — or `npx prisma migrate deploy`.
5. Verify: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
   must report no difference.
