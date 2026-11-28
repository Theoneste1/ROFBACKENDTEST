-- Session inactivity (owner 2026-11-28): a session ends after 60 minutes without user activity. One nullable column on
-- RefreshToken: the session's last user activity. Additive: no change to any existing row (a NULL counts as the token's
-- createdAt). Rollback: docs/migrations/20270102000000_session_activity.rollback.sql.
ALTER TABLE "RefreshToken" ADD COLUMN "lastActivityAt" TIMESTAMP(3);
