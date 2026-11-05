-- DESTRUCTIVE (approved 2026-11-05): live sessions and automatic reminders are
-- removed from the platform.
--   * LiveSession table and its LiveSessionProvider / LiveSessionStatus enums;
--   * Assignment.deadlineRemindedFor (bookkeeping for the removed "due soon"
--     reminder; no user data);
--   * the LIVE_SESSIONS notification category and the LIVE_SESSION_OPENED
--     activity type, with the notifications, e-mail preferences and activity
--     entries that used them;
--   * stored values of the removed settings.
-- Audit-log entries about live sessions are kept (the audit log is append-only).
-- On the development database every affected row count was 0 when written.

-- Rows that use the removed values
DELETE FROM "Notification"           WHERE "category" = 'LIVE_SESSIONS';
DELETE FROM "NotificationPreference" WHERE "category" = 'LIVE_SESSIONS';
DELETE FROM "NotificationSetting"    WHERE "type" LIKE 'live_session.%';
DELETE FROM "ActivityLog"            WHERE "type" = 'LIVE_SESSION_OPENED';
DELETE FROM "SystemSetting" WHERE "key" IN (
  'liveSessions.maxDurationHours',
  'notifications.liveSessionRemindersEnabled',
  'notifications.liveSessionReminderMinutes',
  'notifications.deadlineRemindersEnabled',
  'notifications.deadlineReminderHours'
);

-- DropTable
DROP TABLE "LiveSession";

-- DropEnum
DROP TYPE "LiveSessionProvider";
DROP TYPE "LiveSessionStatus";

-- AlterTable
ALTER TABLE "Assignment" DROP COLUMN "deadlineRemindedFor";

-- AlterEnum
ALTER TYPE "NotificationCategory" RENAME TO "NotificationCategory_old";
CREATE TYPE "NotificationCategory" AS ENUM ('ASSIGNMENTS', 'SUBMISSIONS', 'REVIEWS', 'RESULTS', 'RESOURCES', 'ACCOUNT', 'DISCUSSIONS');
ALTER TABLE "Notification"           ALTER COLUMN "category" TYPE "NotificationCategory" USING ("category"::text::"NotificationCategory");
ALTER TABLE "NotificationPreference" ALTER COLUMN "category" TYPE "NotificationCategory" USING ("category"::text::"NotificationCategory");
DROP TYPE "NotificationCategory_old";

-- AlterEnum
ALTER TYPE "ActivityType" RENAME TO "ActivityType_old";
CREATE TYPE "ActivityType" AS ENUM ('LOGIN', 'COURSE_OPENED', 'COURSE_COMPLETED', 'RESOURCE_VIEWED', 'ASSIGNMENT_VIEWED', 'SUBMISSION_CREATED', 'SUBMISSION_RESUBMITTED', 'RESULT_VIEWED', 'THREAD_CREATED', 'COMMENT_POSTED');
ALTER TABLE "ActivityLog" ALTER COLUMN "type" TYPE "ActivityType" USING ("type"::text::"ActivityType");
DROP TYPE "ActivityType_old";
