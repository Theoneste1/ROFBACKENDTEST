-- Design-areas release post-check (AFTER `prisma migrate deploy` of the design-area migrations: countries; primary teacher;
-- Test Management Phases 1 to 4):
-- READ ONLY.
--
--   node scripts/release/rehearsal.mjs postcheck --release areas-2026    (Neon rehearsal branch; guarded)
--   psql "$DIRECT_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/release/areas-2026-postcheck.sql   (production, in the window)
--
-- Nothing is written: the whole script runs in a READ ONLY transaction. Lines marked "MUST" have to hold;
-- "compare" lines are compared with areas-2026-precheck.sql taken just before the migration.

BEGIN TRANSACTION READ ONLY;

\echo '== 1. MUST be 7, 0, 0: the seven design-area migrations applied; nothing failed or rolled back; nothing after 20261220000400'
SELECT count(*) FILTER (WHERE migration_name IN ('20261211000000_countries_reference', '20261212000000_teacher_school_primary',
                                                 '20261220000000_test_file_purposes', '20261220000100_tests_core',
                                                 '20261220000200_tests_submissions', '20261220000300_tests_marking',
                                                 '20261220000400_tests_publishing')
                          AND finished_at IS NOT NULL AND rolled_back_at IS NULL)               AS areas_applied,
       count(*) FILTER (WHERE migration_name > '20261220000400_tests_publishing')               AS later,
       count(*) FILTER (WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL)                AS failed_or_rolled_back
  FROM "_prisma_migrations";

\echo '== 2. MUST be 1, 1: the table and the School → Country foreign key'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Country')) AS tables,
       (SELECT count(*) FROM pg_constraint WHERE conname = 'School_countryCode_fkey') AS school_country_fk;

\echo '== 3. MUST be 249, +250: every ISO 3166-1 alpha-2 country seeded; Rwanda''s calling code'
SELECT count(*) AS countries, (SELECT "phonePrefix" FROM "Country" WHERE "code" = 'RW') AS rwanda_prefix FROM "Country";

\echo '== 4. MUST be 0: schools whose country is not in the table (the foreign key makes this impossible)'
SELECT count(*) AS schools_without_country FROM "School" s LEFT JOIN "Country" c ON c."code" = s."countryCode" WHERE c."code" IS NULL;

\echo '== 5. compare: schools by country (MUST equal the pre-check)'
SELECT "countryCode", count(*) FROM "School" GROUP BY "countryCode" ORDER BY 1;

\echo '== 6. MUST be 1, 1, 1: the TeacherSchoolRole enum, the role column and the one-primary-per-school index'
SELECT (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'TeacherSchoolRole') AS teacher_school_role_enum,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'TeacherSchoolAssignment' AND column_name = 'role') AS teacher_school_role_column,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'TeacherSchoolAssignment_one_primary_per_school') AS one_primary_index;

\echo '== 7. MUST all be 0: two active primaries in a school; an active primary of an account that is not ACTIVE; an ended primary'
SELECT (SELECT count(*) FROM (SELECT "schoolId" FROM "TeacherSchoolAssignment" WHERE "isActive" AND "role" = 'PRIMARY'
                                GROUP BY "schoolId" HAVING count(*) > 1) d)                                           AS schools_with_two_primaries,
       (SELECT count(*) FROM "TeacherSchoolAssignment" t JOIN "User" u ON u."id" = t."teacherId"
         WHERE t."isActive" AND t."role" = 'PRIMARY' AND u."accountStatus" <> 'ACTIVE')                               AS inactive_account_primaries,
       (SELECT count(*) FROM "TeacherSchoolAssignment" WHERE NOT "isActive" AND "role" = 'PRIMARY')                   AS ended_primaries;

\echo '== 8. MUST be 0 right after the migration: schools whose primary is not their earliest active link of an ACTIVE account (createdAt, then id)'
SELECT count(*) AS primary_not_earliest
  FROM (SELECT DISTINCT ON (t."schoolId") t."schoolId", t."role"
          FROM "TeacherSchoolAssignment" t JOIN "User" u ON u."id" = t."teacherId"
         WHERE t."isActive" AND u."accountStatus" = 'ACTIVE'
         ORDER BY t."schoolId", t."createdAt", t."id") e
 WHERE e."role" <> 'PRIMARY';

\echo '== 9. compare: teacher–school links (MUST equal the pre-check: none made, ended or removed)'
SELECT count(*) AS links, count(*) FILTER (WHERE "isActive") AS active_links, count(*) FILTER (WHERE NOT "isActive") AS ended_links
  FROM "TeacherSchoolAssignment";

\echo '== 10. compare: what the migration did (MUST equal the first six values of the pre-check report; its seventh, ties resolved by id, is information only)'
WITH per AS (
  SELECT s."id",
         count(t."id") FILTER (WHERE t."isActive")                          AS active_links,
         count(t."id") FILTER (WHERE t."isActive" AND t."role" = 'PRIMARY')   AS primaries,
         count(t."id") FILTER (WHERE t."isActive" AND t."role" = 'SECONDARY') AS secondaries
    FROM "School" s
    LEFT JOIN "TeacherSchoolAssignment" t ON t."schoolId" = s."id"
   GROUP BY s."id"
)
SELECT count(*)                                                AS schools_examined,
       count(*) FILTER (WHERE active_links > 0)               AS schools_with_teachers,
       count(*) FILTER (WHERE primaries > 0)                  AS schools_assigned_a_primary,
       count(*) FILTER (WHERE secondaries > 0)                AS schools_with_secondaries,
       count(*) FILTER (WHERE active_links = 0)               AS schools_without_teachers,
       count(*) FILTER (WHERE active_links > 0 AND primaries = 0) AS exceptions
  FROM per;

\echo '== 11. MUST be 4, 4, 3, 1: the Test Management tables, their enums, the new FilePurpose values, the one-active-marker index'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
         AND table_name IN ('Test', 'TestQuestion', 'TestFile', 'MarkerAuthorization'))                          AS test_tables,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
         AND typname IN ('TestDivision', 'TestAnswerFormat', 'TestStatus', 'TestFileKind'))                       AS test_enums,
       (SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'FilePurpose' AND e.enumlabel IN ('TEST_PAPER', 'TEST_ANSWER', 'MARKING_GUIDE'))       AS file_purposes,
       (SELECT count(*) FROM pg_indexes WHERE indexname = 'MarkerAuthorization_one_active_per_coach_subject')     AS one_active_marker_index;

\echo '== 12. MUST be 0, 0, 0, 0: the new tables start empty'
SELECT (SELECT count(*) FROM "Test") AS tests, (SELECT count(*) FROM "TestQuestion") AS questions,
       (SELECT count(*) FROM "TestFile") AS test_files, (SELECT count(*) FROM "MarkerAuthorization") AS marker_authorizations;

\echo '== 13. compare: subjects — every pre-check row unchanged; MUST now include PHYSICS and COMPUTING (and MATHEMATICS where it existed)'
SELECT "code", "name", "isActive", "sortOrder" FROM "Discipline" ORDER BY "code";

\echo '== 14. compare: what Test Management must not touch (MUST equal the pre-check)'
SELECT (SELECT count(*) FROM "ProgrammeMembership")                       AS memberships,
       (SELECT count(*) FROM "ProgrammeMembership" WHERE "isActive")      AS active_memberships,
       (SELECT count(*) FROM "Course")                                    AS courses,
       (SELECT count(*) FROM "Assignment")                                AS assignments,
       (SELECT count(*) FROM "Submission")                                AS submissions,
       (SELECT count(*) FROM "MentorReview")                              AS reviews,
       (SELECT count(*) FROM "FileObject")                                AS files;

\echo '== 15. compare: files by purpose (MUST equal the pre-check)'
SELECT "purpose", count(*) FROM "FileObject" GROUP BY "purpose" ORDER BY 1;

\echo '== 16. MUST be 5, 3, 3, 3: the Test Management Phase 2 tables, enums, guard functions and their triggers'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
         AND table_name IN ('TestExtension', 'TestSubmission', 'TestSubmissionVersion', 'TestAnswerPage', 'TestSubmissionStatusChange')) AS phase2_tables,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
         AND typname IN ('TestExtensionKind', 'TestSubmissionStatus', 'TestSubmitterRole'))                       AS phase2_enums,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('test_submission_version_append_only', 'test_submission_status_append_only', 'test_answer_page_committed_guard')) AS guard_functions,
       (SELECT count(DISTINCT tgname) FROM pg_trigger
         WHERE tgname IN ('test_submission_version_append_only', 'test_submission_status_append_only', 'test_answer_page_committed_guard')) AS guard_triggers;

\echo '== 17. MUST be 3: the one-active-extension indexes (whole test, student, teacher)'
SELECT count(*) AS one_active_extension_indexes FROM pg_indexes
 WHERE indexname IN ('TestExtension_one_active_test', 'TestExtension_one_active_student', 'TestExtension_one_active_teacher');

\echo '== 18. MUST be 0, 0, 0, 0, 0: the Phase 2 tables start empty'
SELECT (SELECT count(*) FROM "TestExtension") AS extensions, (SELECT count(*) FROM "TestSubmission") AS submissions,
       (SELECT count(*) FROM "TestSubmissionVersion") AS versions, (SELECT count(*) FROM "TestAnswerPage") AS answer_pages,
       (SELECT count(*) FROM "TestSubmissionStatusChange") AS status_changes;

\echo '== 19. MUST be 5, 3, 1, 5, 5: the Test Management Phase 3 tables, enums, the finalMarkingId column, guard functions and their triggers'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
         AND table_name IN ('TestMarkerAssignment', 'TestMarking', 'TestMarkingScore', 'TestMarkChange', 'TestReview')) AS phase3_tables,
       (SELECT count(*) FROM pg_type WHERE typnamespace = 'public'::regnamespace
         AND typname IN ('TestMarkingKind', 'TestMarkingStatus', 'TestReviewAction'))                              AS phase3_enums,
       (SELECT count(*) FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'TestSubmission' AND column_name = 'finalMarkingId')        AS final_marking_column,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('test_marker_assignment_guard', 'test_marking_guard', 'test_marking_score_guard',
                         'test_mark_change_append_only', 'test_review_append_only'))                              AS guard_functions,
       (SELECT count(DISTINCT tgname) FROM pg_trigger
         WHERE tgname IN ('test_marker_assignment_guard', 'test_marking_guard', 'test_marking_score_guard',
                          'test_mark_change_append_only', 'test_review_append_only'))                             AS guard_triggers;

\echo '== 20. MUST be 1: one current assignment per submission and kind (partial unique index)'
SELECT count(*) AS one_current_assignment_index FROM pg_indexes WHERE indexname = 'TestMarkerAssignment_one_current';

\echo '== 21. MUST be 0, 0, 0, 0, 0, 0: the Phase 3 tables start empty; no submission has a final marking'
SELECT (SELECT count(*) FROM "TestMarkerAssignment") AS assignments, (SELECT count(*) FROM "TestMarking") AS markings,
       (SELECT count(*) FROM "TestMarkingScore") AS scores, (SELECT count(*) FROM "TestMarkChange") AS mark_changes,
       (SELECT count(*) FROM "TestReview") AS reviews,
       (SELECT count(*) FROM "TestSubmission" WHERE "finalMarkingId" IS NOT NULL) AS final_markings;

\echo '== 22. MUST be 2, 3, 2, 2, 6: the Test Management Phase 4 tables, columns, guard functions, their triggers and CHECKs'
SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'
         AND table_name IN ('TestPublication', 'TestResultWithdrawal'))                                           AS phase4_tables,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public'
         AND ((table_name = 'TestSubmission' AND column_name IN ('publicationId', 'publishedAt'))
           OR (table_name = 'Test' AND column_name = 'studentRankingsVisible')))                                 AS phase4_columns,
       (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace
         AND proname IN ('test_publication_append_only', 'test_result_withdrawal_append_only'))                  AS guard_functions,
       (SELECT count(DISTINCT tgname) FROM pg_trigger
         WHERE tgname IN ('test_publication_append_only', 'test_result_withdrawal_append_only'))                 AS guard_triggers,
       (SELECT count(*) FROM pg_constraint WHERE conname IN ('TestPublication_number_positive', 'TestPublication_count_nonnegative',
         'TestPublication_override_reason', 'TestPublication_counts_object', 'TestResultWithdrawal_reason_present',
         'TestSubmission_published_state'))                                                                      AS checks;

\echo '== 23. MUST be 0, 0, 0, 0, 1: the Phase 4 tables start empty; nothing is published; rankings are never shown to students (design-only CHECK present)'
SELECT (SELECT count(*) FROM "TestPublication") AS publications, (SELECT count(*) FROM "TestResultWithdrawal") AS withdrawals,
       (SELECT count(*) FROM "TestSubmission" WHERE "status" = 'PUBLISHED' OR "publicationId" IS NOT NULL) AS published_results,
       (SELECT count(*) FROM "Test" WHERE "studentRankingsVisible") AS student_rankings_on,
       (SELECT count(*) FROM pg_constraint WHERE conname = 'Test_student_rankings_design_only') AS design_only_check;

ROLLBACK;
