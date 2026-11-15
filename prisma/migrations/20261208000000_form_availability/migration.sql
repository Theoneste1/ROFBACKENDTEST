-- Form availability (registration and website forms): one row per form, the single source of truth for
-- whether it accepts submissions, its schedule and its closed-form message (docs/operations/forms.md).
-- Additive: two new enums and one new table. No existing column or row changes. The two existing switches
-- are COPIED into their forms, so behaviour is identical right after deployment:
--   registration.studentSelfSignup  (default true)  → STUDENT_REGISTRATION  OPEN unless it is stored false
--   registration.teacherSelfSignup  (default false) → TEACHER_REGISTRATION  CLOSED unless it is stored true
--   (no switch existed)                              → COACH_APPLICATION, CONTACT  OPEN
-- From then on the application reads and writes those two settings through this table; their SystemSetting
-- rows are left in place, unused, so a rollback can restore them.
-- Rollback: docs/migrations/20261208000000_form_availability.rollback.sql

-- CreateEnum
CREATE TYPE "FormKey" AS ENUM ('STUDENT_REGISTRATION', 'TEACHER_REGISTRATION', 'COACH_APPLICATION', 'CONTACT');

-- CreateEnum
CREATE TYPE "FormMode" AS ENUM ('OPEN', 'CLOSED', 'SCHEDULED');

-- CreateTable
CREATE TABLE "FormAvailability" (
    "key" "FormKey" NOT NULL,
    "mode" "FormMode" NOT NULL,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "closedMessage" TEXT,
    "instructions" TEXT,
    "contactEmail" TEXT,
    "supportUrl" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormAvailability_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "FormAvailability_updatedById_idx" ON "FormAvailability"("updatedById");

-- AddForeignKey
ALTER TABLE "FormAvailability" ADD CONSTRAINT "FormAvailability_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Data: the current state of every form (see the header). Who last changed a switch is carried over.
INSERT INTO "FormAvailability" ("key", "mode", "updatedById", "updatedAt")
SELECT 'STUDENT_REGISTRATION'::"FormKey",
       CASE WHEN s."value" = 'false'::jsonb THEN 'CLOSED' ELSE 'OPEN' END::"FormMode",
       s."updatedById", CURRENT_TIMESTAMP
  FROM (SELECT 1) one
  LEFT JOIN "SystemSetting" s ON s."key" = 'registration.studentSelfSignup';

INSERT INTO "FormAvailability" ("key", "mode", "updatedById", "updatedAt")
SELECT 'TEACHER_REGISTRATION'::"FormKey",
       CASE WHEN s."value" = 'true'::jsonb THEN 'OPEN' ELSE 'CLOSED' END::"FormMode",
       s."updatedById", CURRENT_TIMESTAMP
  FROM (SELECT 1) one
  LEFT JOIN "SystemSetting" s ON s."key" = 'registration.teacherSelfSignup';

INSERT INTO "FormAvailability" ("key", "mode", "updatedAt") VALUES
  ('COACH_APPLICATION', 'OPEN', CURRENT_TIMESTAMP),
  ('CONTACT',           'OPEN', CURRENT_TIMESTAMP);
