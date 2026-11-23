-- What the new release would record in its first days (synthetic): every launch rollback guard then has data to protect.
BEGIN;
-- sync-modes: a "new schools only" run.
INSERT INTO "SchoolSyncRun" ("id", "datasetKey", "normaliserVersion", "dataSourceId", "datasetLabel", "fileName",
  "fileSha256", "format", "rowCount", "reconciliation", "counts", "reportDigest", "decisionsDigest", "comparedAt", "expiresAt", "mode")
  SELECT 'reh-run-new-only', 'rehearsal', '1', "id", 'Rehearsal', 'n.csv', repeat('0', 64), 'csv', 0, '{}', '{}', 'd', 'd', now(), now() + interval '1 day', 'NEW_ONLY'
    FROM "SchoolDataSource" ORDER BY "id" LIMIT 1;
-- unlisted-school-details: a pending application proposing an unlisted school's official code.
INSERT INTO "TeacherApplication" ("id", "firstName", "lastName", "username", "email", "phone", "country", "schoolProvince",
  "schoolDistrict", "homeDistrict", "homeSector", "proposedSchoolName", "proposedSchoolCode", "proposedSchoolCell", "updatedAt")
  VALUES ('reh-ta-2', 'Nadia', 'Applicant', 'nadia.a', 'nadia.a@example.invalid', '+250700000011', 'RW', 'Kigali', 'Kicukiro',
          'Kicukiro', 'Niboye', 'GS Unlisted', '999901', 'Niboye', now());
-- saved-filters: a Super Administrator's saved filter.
INSERT INTO "RegistrationSavedFilter" ("id", "ownerId", "name", "category", "filter", "columns", "sort", "updatedAt")
  VALUES ('reh-rsf-1', 'reh-super-1', 'Senior students', 'STUDENT', '{"grade": ["S4", "S5", "S6"]}', '["name"]', '[]', now());
-- coach-restrictions: a restriction made by an Administrator (not carried over).
INSERT INTO "CoachProgrammeRestriction" ("id", "coachId", "disciplineId", "capability", "reason", "createdById")
  SELECT 'reh-cpr-1', 'reh-coach-2', d."id", 'RESULTS', 'Results access paused for the rehearsal', 'reh-admin-1'
    FROM "Discipline" d WHERE d."code" = 'MATHEMATICS';
-- form-email-verification: activation turned on for one sign-up form.
UPDATE "FormAvailability" SET "requireEmailVerification" = true WHERE "key" = (SELECT "key" FROM "FormAvailability" ORDER BY "key" LIMIT 1);
-- subscribers: two subscribers and a sent mailing (its e-mail delivered).
INSERT INTO "Subscriber" ("id", "email", "fullName", "kind", "source", "updatedAt")
  VALUES ('reh-sub-1', 'parent@example.invalid', 'A Parent', 'PARENT', 'WEBSITE', now()),
         ('reh-sub-2', 'school@example.invalid', 'A School', 'SCHOOL', 'ADMIN', now());
INSERT INTO "EmailJob" ("id", "idempotencyKey", "subject", "body", "status", "totalRecipients", "sentCount", "createdById", "updatedAt")
  VALUES ('reh-job-news', 'reh-job-news', 'News', 'Hello subscribers', 'COMPLETED', 2, 2, 'reh-admin-1', now());
INSERT INTO "Mailing" ("id", "idempotencyKey", "subject", "body", "audience", "status", "recipientCount", "sentCount", "emailJobId", "createdById", "sentAt")
  VALUES ('reh-mailing-1', 'reh-mailing-1', 'News', 'Hello subscribers', '{"kinds": []}', 'SENT', 2, 2, 'reh-job-news', 'reh-admin-1', now());
INSERT INTO "EmailDelivery" ("id", "jobId", "recipientEmail", "status", "subscriberId")
  VALUES ('reh-delivery-news-1', 'reh-job-news', 'parent@example.invalid', 'SENT', 'reh-sub-1'),
         ('reh-delivery-news-2', 'reh-job-news', 'school@example.invalid', 'SENT', 'reh-sub-2');
-- view-as-sessions: an administrator viewed the platform as a coach (ended).
INSERT INTO "ViewAsSession" ("id", "actorId", "targetId", "reason", "ticketExpiresAt", "startedAt", "expiresAt", "endedAt", "endedReason")
  VALUES ('reh-view-1', 'reh-admin-1', 'reh-coach-1', 'Checking what the coach sees', now(), now(), now() + interval '30 minutes', now(), 'ENDED');
COMMIT;
