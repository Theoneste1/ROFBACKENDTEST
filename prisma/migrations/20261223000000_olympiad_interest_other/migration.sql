-- "Other" Olympiad interest (owner, 2026-11-21): beside MATHEMATICS, COMPUTING and PHYSICS, a person may name another
-- Olympiad in words (e.g. Chemistry). Additive: one nullable text column on User, MentorRequest and TeacherApplication,
-- 2–100 characters when given. The three subjects (OlympiadSubject) are unchanged: "other" is never a subject, never
-- grants marking and is not part of Test Management.
ALTER TABLE "User"               ADD COLUMN "olympiadInterestOther" TEXT;
ALTER TABLE "MentorRequest"      ADD COLUMN "olympiadInterestOther" TEXT;
ALTER TABLE "TeacherApplication" ADD COLUMN "olympiadInterestOther" TEXT;

ALTER TABLE "User"               ADD CONSTRAINT "User_olympiadInterestOther_length"
  CHECK ("olympiadInterestOther" IS NULL OR char_length("olympiadInterestOther") BETWEEN 2 AND 100);
ALTER TABLE "MentorRequest"      ADD CONSTRAINT "MentorRequest_olympiadInterestOther_length"
  CHECK ("olympiadInterestOther" IS NULL OR char_length("olympiadInterestOther") BETWEEN 2 AND 100);
ALTER TABLE "TeacherApplication" ADD CONSTRAINT "TeacherApplication_olympiadInterestOther_length"
  CHECK ("olympiadInterestOther" IS NULL OR char_length("olympiadInterestOther") BETWEEN 2 AND 100);
