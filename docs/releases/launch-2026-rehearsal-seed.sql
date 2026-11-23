-- Production-shaped seed for the launch-2026 rehearsal (a database at levels-2026: every migration up to 20261224000000).
-- Synthetic data only. Users of every role, coach applications (approved with and without an audit entry, pending),
-- a revoked marking authorisation (carried over by coach_programme_access), a pending teacher application, a sync run,
-- e-mails, the activation setting.
BEGIN;
INSERT INTO "User" ("id", "firstName", "lastName", "username", "email", "role", "gradeLevel", "divisionId", "updatedAt")
  SELECT v.id, v.fn, v.ln, v.un, v.un || '@example.invalid', 'STUDENT', v.g::"GradeLevel",
         (SELECT d."id" FROM "Division" d WHERE d."code" = CASE WHEN v.g IN ('S1', 'S2', 'S3') THEN 'JUNIOR' ELSE 'SENIOR' END), now()
    FROM (VALUES ('reh-student-1', 'Aline', 'Uwase', 'aline.u', 'S1'), ('reh-student-2', 'Eric', 'Mugisha', 'eric.m', 'S2'),
                 ('reh-student-3', 'Grace', 'Ingabire', 'grace.i', 'S3'), ('reh-student-4', 'Kevin', 'Habimana', 'kevin.h', 'S4'),
                 ('reh-student-5', 'Diane', 'Umutoni', 'diane.u', 'S5'), ('reh-student-6', 'Patrick', 'Niyonzima', 'patrick.n', 'S6')) v(id, fn, ln, un, g);
INSERT INTO "User" ("id", "firstName", "lastName", "username", "email", "role", "updatedAt") VALUES
  ('reh-coach-1',   'Jean',   'Coach',     'jean.c',   'jean.c@example.invalid',   'MENTOR',      now()),
  ('reh-coach-2',   'Marie',  'Coach',     'marie.c',  'marie.c@example.invalid',  'MENTOR',      now()),
  ('reh-head-1',    'Paul',   'Head',      'paul.h',   'paul.h@example.invalid',   'HEAD_COACH',  now()),
  ('reh-teacher-1', 'Claire', 'Teacher',   'claire.t', 'claire.t@example.invalid', 'TEACHER',     now()),
  ('reh-admin-1',   'Alice',  'Admin',     'alice.a',  'alice.a@example.invalid',  'ADMIN',       now()),
  ('reh-super-1',   'Sam',    'Super',     'sam.s',    'sam.s@example.invalid',    'SUPER_ADMIN', now());

-- Coaches in Mathematics; coach 1's marking authorisation was revoked (carried over as a MARKING restriction).
INSERT INTO "ProgrammeMembership" ("id", "userId", "disciplineId", "source")
  SELECT 'reh-pm-' || u.id, u.id, d.id, 'MANUAL' FROM "User" u, "Discipline" d
   WHERE u.id IN ('reh-coach-1', 'reh-coach-2') AND d."code" = 'MATHEMATICS'
  ON CONFLICT DO NOTHING;
INSERT INTO "MarkerAuthorization" ("id", "coachId", "disciplineId", "grantedAt", "revokedAt", "revokedById", "revokeReason")
  SELECT 'reh-ma-1', 'reh-coach-1', d.id, now() - interval '10 days', now() - interval '2 days', 'reh-admin-1', 'Marked outside the guide'
    FROM "Discipline" d WHERE d."code" = 'MATHEMATICS';
INSERT INTO "MarkerAuthorization" ("id", "coachId", "disciplineId", "grantedAt")
  SELECT 'reh-ma-2', 'reh-coach-2', d.id, now() - interval '10 days' FROM "Discipline" d WHERE d."code" = 'MATHEMATICS';

-- Coach applications: approved with the audit entry naming the account; approved without (matched by e-mail); pending.
INSERT INTO "MentorRequest" ("id", "firstName", "lastName", "username", "email", "status", "updatedAt") VALUES
  ('reh-mr-1', 'Jean',  'Coach', 'jean.c',  'jean.c@example.invalid',  'APPROVED', now()),
  ('reh-mr-2', 'Marie', 'Coach', 'marie.c', 'marie.c@example.invalid', 'APPROVED', now()),
  ('reh-mr-3', 'New',   'Coach', 'new.c',   'new.c@example.invalid',   'PENDING',  now());
INSERT INTO "AuditLog" ("id", "action", "entity", "entityId", "metadata") VALUES
  ('reh-audit-1', 'APPROVE_MENTOR_REQUEST', 'MentorRequest', 'reh-mr-1', '{"newUserId": "reh-coach-1"}');

-- A pending teacher application (an unlisted school, before the release: name and place only).
INSERT INTO "TeacherApplication" ("id", "firstName", "lastName", "username", "email", "phone", "country", "schoolProvince",
  "schoolDistrict", "homeDistrict", "homeSector", "proposedSchoolName", "updatedAt")
  VALUES ('reh-ta-1', 'Claude', 'Applicant', 'claude.a', 'claude.a@example.invalid', '+250700000010', 'RW', 'Kigali', 'Gasabo',
          'Gasabo', 'Remera', 'GS Rehearsal', now());

-- A completed directory sync run (FULL before the release).
INSERT INTO "SchoolSyncRun" ("id", "datasetKey", "normaliserVersion", "dataSourceId", "datasetLabel", "fileName",
  "fileSha256", "format", "rowCount", "reconciliation", "counts", "reportDigest", "decisionsDigest", "comparedAt", "expiresAt")
  SELECT 'reh-run-1', 'rehearsal', '1', "id", 'Rehearsal', 'r.csv', repeat('0', 64), 'csv', 0, '{}', '{}', 'd', 'd', now(), now() + interval '1 day'
    FROM "SchoolDataSource" ORDER BY "id" LIMIT 1;

-- E-mails already sent.
INSERT INTO "EmailJob" ("id", "idempotencyKey", "subject", "body", "status", "totalRecipients", "sentCount", "createdById", "updatedAt")
  VALUES ('reh-job-1', 'reh-job-1', 'Welcome', 'Hello', 'COMPLETED', 1, 1, 'reh-admin-1', now());
INSERT INTO "EmailDelivery" ("id", "jobId", "recipientEmail", "status") VALUES ('reh-delivery-1', 'reh-job-1', 'aline.u@example.invalid', 'SENT');

-- The single activation setting the previous release reads.
INSERT INTO "SystemSetting" ("key", "value", "updatedAt") VALUES ('registration.requireEmailVerification', 'false', now())
  ON CONFLICT ("key") DO NOTHING;
COMMIT;
