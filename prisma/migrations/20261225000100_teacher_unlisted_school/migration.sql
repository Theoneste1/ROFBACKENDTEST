-- Teacher registration, "My school is not listed" (owner decision 2026-11-22): the applicant gives the school's
-- official details, so an Administrator's approval creates the school with no retyping. Additive; nullable
-- (applications made before this release keep only the name and place).
ALTER TABLE "TeacherApplication"
  ADD COLUMN "proposedSchoolCode"          TEXT,
  ADD COLUMN "proposedSchoolCell"          TEXT,
  ADD COLUMN "proposedSchoolVillage"       TEXT,
  ADD COLUMN "proposedSchoolOwnership"     TEXT,
  ADD COLUMN "proposedSchoolAccommodation" "SchoolAccommodation";
