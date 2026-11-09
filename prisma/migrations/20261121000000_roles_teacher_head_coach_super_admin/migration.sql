-- M1 (Phase 1, Step 5): the three new role values.
-- Forward-only and inert: no row uses them, and the application refuses to
-- assign them (role allow-list; TEACHERS_ENABLED / HEAD_COACHES_ENABLED off by
-- default; SUPER_ADMIN never through the user API). No existing value, row,
-- column or constraint changes.
-- Rollback (only while unused): docs/migrations/20261121000000_roles_teacher_head_coach_super_admin.rollback.sql
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'TEACHER';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'HEAD_COACH';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'SUPER_ADMIN';
