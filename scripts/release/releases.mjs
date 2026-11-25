// The releases the rehearsal kit handles: exactly which migrations each one deploys and rolls back, its read-only
// checks, and what must be gone before its history rows may be removed. Shared by the rehearsal runner and its tests.
import { PHASE1, PHASE1_COUNT, LAST_PHASE1_TIMESTAMP } from './phase1.mjs';

/**
 * The post-Phase-1 release: the migrations after M14, in the order Prisma applies them (name order). The nine of
 * develop c39df18 (owner approval 2026-11-17), plus application details (2026-11-17, ADR-009) and teacher–student access
 * (2026-11-18, TS-1…TS-6): the owner asked for one complete release, not partial ones. Listed explicitly — a migration added later is never part of it.
 */
export const POST_PHASE1_MIGRATIONS = [
  '20261201000000_teacher_applications',
  '20261202000000_notification_outbox',
  '20261203000000_student_olympiad_interests',
  '20261204000000_registration_details',
  '20261205000000_avatar_file_purpose',
  '20261206000000_account_states',
  '20261207000000_bulk_operations',
  '20261207000100_bulk_membership_guard',
  '20261208000000_form_availability',
  '20261209000000_application_details',
  '20261210000000_teacher_student_access',
];

/**
 * What the post-Phase-1 migrations create (checked against their SQL by the tests). `rollback-history` refuses while any of
 * it is left. Not listed: the FilePurpose value 'AVATAR' (PostgreSQL cannot drop an enum value; the rollback keeps it,
 * unused) and indexes (dropped with their tables or columns).
 */
export const POST_PHASE1_OBJECTS = {
  tables: ['ApplicationInfoRequest', 'BulkOperation', 'BulkOperationItem', 'FormAvailability', 'NotificationOutbox', 'TeacherApplication',
    'TeacherStudentAssignment', 'UserPermissionOverrideStudent', 'UserStatusChange'],
  enums: ['AccountStatus', 'BulkItemOutcome', 'BulkOperationStatus', 'CoachEducationLevel', 'FormKey', 'FormMode',
    'NotificationOutboxStatus', 'OlympiadSubject', 'TeacherApplicationStatus', 'DelegationStudentScope', 'TeacherStudentSource'],
  columns: [
    ['MentorRequest', 'country'], ['MentorRequest', 'educationLevel'], ['MentorRequest', 'occupation'], ['MentorRequest', 'olympiadInterests'],
    ['MentorRequest', 'affiliation'], ['MentorRequest', 'expertise'], ['MentorRequest', 'phone'], ['MentorRequest', 'rejectionReason'],
    ['MentorRequest', 'relevantExperience'], ['MentorRequest', 'yearsOfExperience'], ['MentorRequest', 'avatarFileId'],
    ['User', 'accountStatus'], ['User', 'avatarFileId'], ['User', 'country'], ['User', 'dateOfBirth'], ['User', 'guardianPhone'],
    ['User', 'homeDistrict'], ['User', 'homeProvince'], ['User', 'homeSector'], ['User', 'olympiadInterests'], ['User', 'phone'],
    ['UserPermissionOverride', 'studentScope'], ['UserPermissionOverride', 'reviewNeededAt'], ['UserPermissionOverride', 'reviewReason'],
  ],
  triggers: ['user_account_status_sync', 'user_bulk_membership_guard'],
  functions: ['user_account_status_sync', 'user_bulk_membership_guard'],
};

/**
 * The design-areas release: the migrations after the post-Phase-1 eleven. Area 1 as simplified by the owner (2026-11-19):
 * the countries reference list and the School → Country foreign key; then the primary teacher of a school (owner
 * decision 2026-11-19); then Test Management Phases 1 to 4 (owner-approved plan 2026-11-19). Listed explicitly — a migration added later is never
 * part of it until it is appended here on purpose.
 */
export const AREAS_2026_MIGRATIONS = [
  '20261211000000_countries_reference',
  // Primary teacher of a school (owner decision 2026-11-19): TeacherSchoolAssignment.role + one active primary per school.
  '20261212000000_teacher_school_primary',
  // Test Management, Phase 1 (WS3, owner-approved plan 2026-11-19): M-a the private file purposes TEST_PAPER, TEST_ANSWER,
  // MARKING_GUIDE (enum values only); M-b the Test, TestQuestion, TestFile and MarkerAuthorization tables and the Physics
  // and Computing subjects.
  '20261220000000_test_file_purposes',
  '20261220000100_tests_core',
  // Test Management, Phase 2: M-c TestExtension, TestSubmission, TestSubmissionVersion (append-only), TestAnswerPage and
  // TestSubmissionStatusChange (append-only), their enums and guard triggers.
  '20261220000200_tests_submissions',
  // Test Management, Phase 3: M-d (part 1) TestMarkerAssignment, TestMarking, TestMarkingScore, TestMarkChange
  // (append-only), TestReview (append-only), TestSubmission.finalMarkingId, their enums and guard triggers.
  '20261220000300_tests_marking',
  // Test Management, Phase 4: M-d (part 2) TestPublication (append-only), TestResultWithdrawal (append-only, G6),
  // TestSubmission.publicationId / publishedAt, Test.studentRankingsVisible (design only), CHECKs and guard triggers.
  '20261220000400_tests_publishing',
];

/** What the design-areas migrations create (checked against their SQL by the tests); `rollback-history` refuses while any is left. */
export const AREAS_2026_OBJECTS = {
  // Not listed: the FilePurpose values TEST_PAPER, TEST_ANSWER, MARKING_GUIDE (PostgreSQL cannot drop an enum value; the
  // rollback keeps them, unused) and the Physics / Computing Discipline rows (data, removed by the tests_core rollback).
  tables: ['Country', 'MarkerAuthorization', 'Test', 'TestAnswerPage', 'TestExtension', 'TestFile', 'TestMarkChange', 'TestMarkerAssignment',
    'TestMarking', 'TestMarkingScore', 'TestPublication', 'TestQuestion', 'TestResultWithdrawal', 'TestReview', 'TestSubmission',
    'TestSubmissionStatusChange', 'TestSubmissionVersion'],
  enums: ['TeacherSchoolRole', 'TestAnswerFormat', 'TestDivision', 'TestExtensionKind', 'TestFileKind', 'TestMarkingKind', 'TestMarkingStatus',
    'TestReviewAction', 'TestStatus', 'TestSubmissionStatus', 'TestSubmitterRole'],
  // TestSubmission.finalMarkingId (Phase 3), TestSubmission.publicationId / publishedAt and Test.studentRankingsVisible
  // (Phase 4) are columns of tables this release creates: dropped with them.
  columns: [['TeacherSchoolAssignment', 'role']],
  triggers: ['test_answer_page_committed_guard', 'test_mark_change_append_only', 'test_marker_assignment_guard', 'test_marking_guard',
    'test_marking_score_guard', 'test_publication_append_only', 'test_result_withdrawal_append_only', 'test_review_append_only',
    'test_submission_status_append_only', 'test_submission_version_append_only'],
  functions: ['test_answer_page_committed_guard', 'test_mark_change_append_only', 'test_marker_assignment_guard', 'test_marking_guard',
    'test_marking_score_guard', 'test_publication_append_only', 'test_result_withdrawal_append_only', 'test_review_append_only',
    'test_submission_status_append_only', 'test_submission_version_append_only'],
};

/**
 * The late-2026 release: the migrations after the design areas. The sign-up work (owner, 2026-11-20): gender at every
 * sign-up; the home location on every registration form; then the generic bulk engine (Bulk Actions). Listed explicitly — a migration added later is never part of it
 * until it is appended here on purpose.
 */
export const LATE_2026_MIGRATIONS = [
  // Gender at every sign-up: the Gender enum; a nullable gender on User, MentorRequest and TeacherApplication.
  '20261221000000_registration_gender',
  // Home location: TeacherApplication.homeProvince (district and sector become optional); MentorRequest home place.
  '20261221000100_home_location',
  // Generic bulk engine (2026-11-19): BulkOperation.entityType, BulkOperationItem.entityId (backfilled), userId nullable.
  '20261222000000_bulk_operations_generic',
];

/** What the late-2026 migrations create (checked against their SQL by the tests); `rollback-history` refuses while any is left. */
export const LATE_2026_OBJECTS = {
  tables: [],
  enums: ['Gender'],
  columns: [
    ['User', 'gender'], ['MentorRequest', 'gender'], ['TeacherApplication', 'gender'],
    ['TeacherApplication', 'homeProvince'], ['MentorRequest', 'homeDistrict'], ['MentorRequest', 'homeProvince'], ['MentorRequest', 'homeSector'],
    ['BulkOperation', 'entityType'], ['BulkOperationItem', 'entityId'],
  ],
  triggers: ['bulk_item_entity_from_user'],
  functions: ['bulk_item_entity_from_user'],
};

/**
 * The dec-2026 release: the "Other" Olympiad interest (owner, 2026-11-21), after late-2026 (applied to production on
 * 2026-11-21). Listed explicitly — a migration added later is never part of it until it is appended here on purpose.
 */
export const DEC_2026_MIGRATIONS = [
  // "Other" Olympiad interest: a nullable olympiadInterestOther (2–100 characters) on User, MentorRequest and TeacherApplication.
  '20261223000000_olympiad_interest_other',
  // Locked test submissions (owner, 2026-11-21): TestResubmissionAuthorization (an Administrator unlocks one replacement).
  '20261223000100_test_resubmission_lock',
];

/** What the dec-2026 migration creates (checked against its SQL by the tests); `rollback-history` refuses while any is left. */
export const DEC_2026_OBJECTS = {
  tables: ['TestResubmissionAuthorization'],
  enums: [],
  columns: [['User', 'olympiadInterestOther'], ['MentorRequest', 'olympiadInterestOther'], ['TeacherApplication', 'olympiadInterestOther']],
  triggers: [],
  functions: [],
};

/** The Phase 1 migrations (M1–M14), in apply order. */
export const PHASE1_MIGRATIONS = [
  '20261121000000_roles_teacher_head_coach_super_admin',
  '20261121000100_programme_membership',
  '20261121000200_backfill_programme_membership',
  '20261121000300_last_super_admin_guard',
  '20261121000400_permission_overrides',
  '20261121000500_teacher_school_assignment',
  '20261121000600_school_codes',
  '20261121000700_official_school_list',
  '20261121000800_student_school_affiliation',
  '20261121000900_school_affiliation_integrity',
  '20261121001000_school_administration',
  '20261121001100_school_directory_model',
  '20261121001200_school_directory_sync',
  '20261121001300_school_directory_sync_approval',
];

/**
 * Everything each migration changes in the schema, per migration (derived from the migrations; the tests prove it equals
 * the catalogue difference each migration's SQL makes, so the lists cannot drift). `rollback` uses it to tell, before
 * running a migration's files, whether that migration is
 *   - in place: every marker holds (run its files);
 *   - already rolled back: no marker holds (skip it — this is what lets an interrupted rollback be resumed);
 *   - half rolled back: some hold, some do not (refused, with the list of what remains; none of its files run).
 * A missing table alone never counts as rolled back: every object below is checked.
 *   creates  tables and enums it creates; columns, indexes, constraints and triggers it adds to tables it did not create
 *            (those of a table it creates go with the table); values it adds to an enum it did not create; functions.
 *            Marker: the object exists.
 *   drops    objects it removes and its rollback restores (e.g. a unique index it replaces). Marker: the object is absent.
 *   history  (Phase 1 M1–M8) the migration's _prisma_migrations row: those rollback files delete it in the same transaction
 *            as the rest of the file — the only marker of the data-only M3 and M8 (backfilled rows, official school list).
 *            Marker: the row exists.
 *   kept     what the migration creates and its rollback deliberately KEEPS, so it is not a marker: the FilePurpose value
 *            'AVATAR' (PostgreSQL cannot drop an enum value; the rollback file says so).
 *   checkOnly a migration with no marker at all (it only adds kept enum values: test_file_purposes): its rollback file
 *            changes nothing and only checks (its guard), so it runs every time `rollback` reaches it and is ignored by the
 *            order and completeness checks.
 * Data a rollback restores (values written back, rows revoked) lives in objects listed here, so it is checked through them.
 */
export const MIGRATION_OBJECTS = {
  '20261121000000_roles_teacher_head_coach_super_admin': {
    creates: {
      enumValues: [['Role', 'HEAD_COACH'], ['Role', 'SUPER_ADMIN'], ['Role', 'TEACHER']],
    },
    history: true,
  },
  '20261121000100_programme_membership': {
    creates: {
      enums: ['MembershipSource'],
      tables: ['ProgrammeMembership'],
    },
    history: true,
  },
  '20261121000200_backfill_programme_membership': {
    history: true,
  },
  '20261121000300_last_super_admin_guard': {
    creates: {
      functions: ['user_last_super_admin_guard'],
      triggers: [['User', 'user_last_super_admin_guard']],
    },
    history: true,
  },
  '20261121000400_permission_overrides': {
    creates: {
      enums: ['OverrideEffect'],
      tables: ['UserPermissionOverride'],
    },
    history: true,
  },
  '20261121000500_teacher_school_assignment': {
    creates: {
      tables: ['TeacherSchoolAssignment'],
    },
    history: true,
  },
  '20261121000600_school_codes': {
    creates: {
      columns: [['School', 'code'], ['School', 'district'], ['School', 'nameKey'], ['School', 'ownership'], ['School', 'province'], ['School', 'sector']],
      indexes: [['School', 'School_code_key'], ['School', 'School_nameKey_idx'], ['School', 'School_province_district_sector_idx']],
    },
    history: true,
  },
  '20261121000700_official_school_list': {
    history: true,
  },
  '20261121000800_student_school_affiliation': {
    creates: {
      enums: ['SchoolAffiliationSource', 'SchoolAffiliationStatus'],
      tables: ['StudentSchoolAffiliation'],
    },
  },
  '20261121000900_school_affiliation_integrity': {
    creates: {
      functions: ['school_affiliation_integrity'],
      triggers: [['StudentSchoolAffiliation', 'school_affiliation_integrity'], ['User', 'user_school_affiliation_integrity']],
    },
  },
  '20261121001000_school_administration': {
    creates: {
      columns: [['School', 'countryCode'], ['School', 'createdById'], ['School', 'isActive'], ['School', 'source'], ['School', 'updatedAt']],
      constraints: [['School', 'School_createdById_fkey']],
      enums: ['SchoolSource'],
      indexes: [['School', 'School_countryCode_isActive_idx'], ['School', 'School_createdById_idx']],
    },
  },
  '20261121001100_school_directory_model': {
    creates: {
      columns: [['School', 'accommodation'], ['School', 'cell'], ['School', 'lastSourceSyncAt'], ['School', 'lastVerifiedAt'], ['School', 'lastVerifiedById'], ['School', 'village']],
      constraints: [['School', 'School_lastVerifiedById_fkey']],
      enums: ['ProgrammeCategory', 'SchoolAccommodation', 'SchoolContactType', 'SchoolContactVisibility', 'SchoolExternalIdKind'],
      functions: ['school_contact_keep', 'school_external_id_keep', 'school_source_record_immutable'],
      indexes: [['School', 'School_lastVerifiedById_idx'], ['School', 'School_name_idx']],
      tables: ['EducationLevel', 'Programme', 'SchoolContact', 'SchoolDataSource', 'SchoolEducationLevel', 'SchoolExternalId', 'SchoolProgramme', 'SchoolSourceRecord'],
    },
    drops: { indexes: [['School', 'School_name_key']] },
  },
  '20261121001200_school_directory_sync': {
    creates: {
      columns: [['SchoolSourceRecord', 'syncRunId']],
      constraints: [['SchoolSourceRecord', 'SchoolSourceRecord_syncRunId_fkey']],
      enums: ['SchoolSyncChangeKind', 'SchoolSyncConflictState', 'SchoolSyncDecision', 'SchoolSyncItemOutcome', 'SchoolSyncRunStatus'],
      functions: ['school_sync_run_guard', 'school_sync_staging_keep'],
      indexes: [['SchoolSourceRecord', 'SchoolSourceRecord_syncRunId_idx']],
      tables: ['SchoolSyncChange', 'SchoolSyncItem', 'SchoolSyncRun'],
    },
  },
  '20261121001300_school_directory_sync_approval': {
    creates: {
      columns: [['SchoolSyncChange', 'retiredAt'], ['SchoolSyncRun', 'approvalTokenId'], ['SchoolSyncRun', 'approvedAt'], ['SchoolSyncRun', 'approvedById'], ['SchoolSyncRun', 'approvedGeneration']],
      constraints: [['SchoolSyncRun', 'SchoolSyncRun_approvedById_fkey']],
      indexes: [['SchoolSyncChange', 'SchoolSyncChange_runId_retiredAt_idx'], ['SchoolSyncRun', 'SchoolSyncRun_approvedById_idx']],
    },
  },
  '20261201000000_teacher_applications': {
    creates: {
      columns: [['User', 'country'], ['User', 'phone']],
      enums: ['OlympiadSubject', 'TeacherApplicationStatus'],
      tables: ['TeacherApplication'],
    },
  },
  '20261202000000_notification_outbox': {
    creates: {
      columns: [['TeacherApplication', 'schoolVerifiedAt'], ['TeacherApplication', 'schoolVerifiedById']],
      constraints: [['TeacherApplication', 'TeacherApplication_schoolVerifiedById_fkey']],
      enums: ['NotificationOutboxStatus'],
      indexes: [['TeacherApplication', 'TeacherApplication_schoolVerifiedById_idx']],
      tables: ['NotificationOutbox'],
    },
  },
  '20261203000000_student_olympiad_interests': {
    creates: {
      columns: [['User', 'olympiadInterests']],
    },
  },
  '20261204000000_registration_details': {
    creates: {
      columns: [['MentorRequest', 'country'], ['MentorRequest', 'educationLevel'], ['MentorRequest', 'occupation'], ['MentorRequest', 'olympiadInterests'], ['User', 'dateOfBirth'], ['User', 'guardianPhone'], ['User', 'homeDistrict'], ['User', 'homeProvince'], ['User', 'homeSector']],
      enums: ['CoachEducationLevel'],
    },
  },
  '20261205000000_avatar_file_purpose': {
    creates: {
      columns: [['User', 'avatarFileId']],
      constraints: [['User', 'User_avatarFileId_fkey']],
      indexes: [['User', 'User_avatarFileId_key']],
    },
    kept: { enumValues: [['FilePurpose', 'AVATAR']] },
  },
  '20261206000000_account_states': {
    creates: {
      columns: [['User', 'accountStatus']],
      enums: ['AccountStatus'],
      functions: ['user_account_status_sync'],
      indexes: [['User', 'User_accountStatus_idx'], ['User', 'User_role_accountStatus_idx']],
      tables: ['UserStatusChange'],
      triggers: [['User', 'user_account_status_sync']],
    },
  },
  '20261207000000_bulk_operations': {
    creates: {
      enums: ['BulkItemOutcome', 'BulkOperationStatus'],
      indexes: [['User', 'User_createdAt_idx'], ['User', 'User_gradeLevel_idx']],
      tables: ['BulkOperation', 'BulkOperationItem'],
    },
  },
  '20261207000100_bulk_membership_guard': {
    creates: {
      functions: ['user_bulk_membership_guard'],
      triggers: [['User', 'user_bulk_membership_guard']],
    },
  },
  '20261208000000_form_availability': {
    creates: {
      enums: ['FormKey', 'FormMode'],
      tables: ['FormAvailability'],
    },
  },
  '20261209000000_application_details': {
    creates: {
      columns: [['MentorRequest', 'affiliation'], ['MentorRequest', 'avatarFileId'], ['MentorRequest', 'expertise'], ['MentorRequest', 'phone'], ['MentorRequest', 'rejectionReason'], ['MentorRequest', 'relevantExperience'], ['MentorRequest', 'yearsOfExperience'], ['TeacherApplication', 'avatarFileId'], ['TeacherApplication', 'position'], ['TeacherApplication', 'yearsOfExperience']],
      constraints: [['MentorRequest', 'MentorRequest_avatarFileId_fkey'], ['MentorRequest', 'MentorRequest_yearsOfExperience_check'], ['TeacherApplication', 'TeacherApplication_avatarFileId_fkey'], ['TeacherApplication', 'TeacherApplication_yearsOfExperience_check']],
      indexes: [['MentorRequest', 'MentorRequest_active_email_key'], ['MentorRequest', 'MentorRequest_active_username_key'], ['MentorRequest', 'MentorRequest_avatarFileId_key'], ['MentorRequest', 'MentorRequest_email_idx'], ['MentorRequest', 'MentorRequest_username_idx'], ['TeacherApplication', 'TeacherApplication_avatarFileId_key']],
      tables: ['ApplicationInfoRequest'],
    },
    drops: { indexes: [['MentorRequest', 'MentorRequest_email_key'], ['MentorRequest', 'MentorRequest_username_key']] },
  },
  '20261210000000_teacher_student_access': {
    creates: {
      columns: [['UserPermissionOverride', 'reviewNeededAt'], ['UserPermissionOverride', 'reviewReason'], ['UserPermissionOverride', 'studentScope']],
      constraints: [['UserPermissionOverride', 'UserPermissionOverride_student_scope']],
      enums: ['DelegationStudentScope', 'TeacherStudentSource'],
      tables: ['TeacherStudentAssignment', 'UserPermissionOverrideStudent'],
    },
  },
  '20261211000000_countries_reference': {
    creates: {
      constraints: [['School', 'School_countryCode_fkey']],
      tables: ['Country'],
    },
  },
  '20261212000000_teacher_school_primary': {
    creates: {
      columns: [['TeacherSchoolAssignment', 'role']],
      enums: ['TeacherSchoolRole'],
      indexes: [['TeacherSchoolAssignment', 'TeacherSchoolAssignment_one_primary_per_school']],
    },
  },
  // Adds three FilePurpose values only, and its rollback KEEPS them (PostgreSQL cannot drop an enum value): nothing tells
  // whether its rollback file ran. checkOnly: the file changes nothing (it only checks, with its guard), so `rollback` runs
  // it every time it reaches it, and it never counts as present or rolled back for the order and completeness checks.
  '20261220000000_test_file_purposes': {
    checkOnly: true,
    kept: { enumValues: [['FilePurpose', 'MARKING_GUIDE'], ['FilePurpose', 'TEST_ANSWER'], ['FilePurpose', 'TEST_PAPER']] },
  },
  '20261220000100_tests_core': {
    creates: {
      enums: ['TestAnswerFormat', 'TestDivision', 'TestFileKind', 'TestStatus'],
      tables: ['MarkerAuthorization', 'Test', 'TestFile', 'TestQuestion'],
    },
  },
  '20261220000200_tests_submissions': {
    creates: {
      enums: ['TestExtensionKind', 'TestSubmissionStatus', 'TestSubmitterRole'],
      functions: ['test_answer_page_committed_guard', 'test_submission_status_append_only', 'test_submission_version_append_only'],
      tables: ['TestAnswerPage', 'TestExtension', 'TestSubmission', 'TestSubmissionStatusChange', 'TestSubmissionVersion'],
    },
  },
  '20261220000300_tests_marking': {
    creates: {
      columns: [['TestSubmission', 'finalMarkingId']],
      constraints: [['TestSubmission', 'TestSubmission_finalMarkingId_fkey']],
      enums: ['TestMarkingKind', 'TestMarkingStatus', 'TestReviewAction'],
      functions: ['test_mark_change_append_only', 'test_marker_assignment_guard', 'test_marking_guard', 'test_marking_score_guard', 'test_review_append_only'],
      indexes: [['TestSubmission', 'TestSubmission_finalMarkingId_key']],
      tables: ['TestMarkChange', 'TestMarkerAssignment', 'TestMarking', 'TestMarkingScore', 'TestReview'],
    },
  },
  '20261220000400_tests_publishing': {
    creates: {
      columns: [['Test', 'studentRankingsVisible'], ['TestSubmission', 'publicationId'], ['TestSubmission', 'publishedAt']],
      constraints: [['Test', 'Test_student_rankings_design_only'], ['TestSubmission', 'TestSubmission_publicationId_fkey'], ['TestSubmission', 'TestSubmission_published_state']],
      functions: ['test_publication_append_only', 'test_result_withdrawal_append_only'],
      indexes: [['TestSubmission', 'TestSubmission_publicationId_idx']],
      tables: ['TestPublication', 'TestResultWithdrawal'],
    },
  },
  '20261221000000_registration_gender': {
    creates: {
      columns: [['MentorRequest', 'gender'], ['TeacherApplication', 'gender'], ['User', 'gender']],
      enums: ['Gender'],
    },
  },
  '20261221000100_home_location': {
    creates: {
      columns: [['MentorRequest', 'homeDistrict'], ['MentorRequest', 'homeProvince'], ['MentorRequest', 'homeSector'], ['TeacherApplication', 'homeProvince']],
    },
  },
  '20261222000000_bulk_operations_generic': {
    creates: {
      columns: [['BulkOperation', 'entityType'], ['BulkOperationItem', 'entityId']],
      functions: ['bulk_item_entity_from_user'],
      indexes: [['BulkOperation', 'BulkOperation_selectionToken_v2_key'], ['BulkOperationItem', 'BulkOperationItem_operationId_entityId_key']],
      triggers: [['BulkOperationItem', 'bulk_item_entity_from_user']],
    },
  },
  '20261223000000_olympiad_interest_other': {
    creates: {
      columns: [['MentorRequest', 'olympiadInterestOther'], ['TeacherApplication', 'olympiadInterestOther'], ['User', 'olympiadInterestOther']],
      constraints: [['MentorRequest', 'MentorRequest_olympiadInterestOther_length'], ['TeacherApplication', 'TeacherApplication_olympiadInterestOther_length'],
        ['User', 'User_olympiadInterestOther_length']],
    },
  },
  '20261223000100_test_resubmission_lock': {
    creates: {
      tables: ['TestResubmissionAuthorization'],
    },
  },
  '20261224000000_divisions_levels': {
    creates: {
      columns: [['Division', 'sortOrder'], ['Division', 'suggestedGrades'], ['TestSubmission', 'level'], ['User', 'divisionManual']],
      constraints: [['Division', 'Division_code_format']],
      enums: ['DivisionChangeSource'],
      functions: ['course_offered_in_divisions', 'division_for_grade', 'student_division_from_grade', 'student_division_history'],
      tables: ['CourseDivision', 'CustomReport', 'CustomReportGrant', 'DivisionChange', 'TableLayout'],
      triggers: [['Course', 'course_offered_in_divisions'], ['User', 'student_division_from_grade'], ['User', 'student_division_history']],
    },
    // Division.code and Test.division become text: the two enums are dropped, and the rollback creates them again.
    drops: { enums: ['DivisionCode', 'TestDivision'] },
  },
  '20261225000000_school_sync_mode': {
    creates: {
      columns: [['SchoolSyncRun', 'mode']],
      enums: ['SchoolSyncMode'],
    },
  },
  '20261225000100_teacher_unlisted_school': {
    creates: {
      columns: [['TeacherApplication', 'proposedSchoolAccommodation'], ['TeacherApplication', 'proposedSchoolCell'], ['TeacherApplication', 'proposedSchoolCode'],
        ['TeacherApplication', 'proposedSchoolOwnership'], ['TeacherApplication', 'proposedSchoolVillage']],
    },
  },
  '20261226000000_registration_data': {
    creates: {
      columns: [['MentorRequest', 'userId']],
      constraints: [['MentorRequest', 'MentorRequest_userId_fkey']],
      indexes: [['MentorRequest', 'MentorRequest_userId_key']],
      tables: ['RegistrationSavedFilter'],
    },
  },
  '20261227000000_coach_programme_access': {
    creates: {
      enums: ['CoachCapability'],
      tables: ['CoachProgrammeRestriction'],
    },
  },
  '20261228000000_form_email_verification': {
    creates: {
      columns: [['FormAvailability', 'requireEmailVerification']],
    },
  },
  '20261229000000_subscribers': {
    creates: {
      columns: [['EmailDelivery', 'subscriberId']],
      constraints: [['EmailDelivery', 'EmailDelivery_subscriberId_fkey']],
      enums: ['MailingStatus', 'SubscriberKind', 'SubscriberSource', 'SubscriberStatus'],
      indexes: [['EmailDelivery', 'EmailDelivery_subscriberId_idx']],
      tables: ['Mailing', 'Subscriber'],
    },
  },
  '20261230000000_view_as': {
    creates: {
      tables: ['ViewAsSession'],
    },
  },
};

/**
 * The acknowledgements `rollback --acknowledge <id>` accepts: a FIXED allow-list, each id mapped to the exact session
 * setting and value its rollback file's data-loss guard checks (`current_setting('rof.…', true) IS DISTINCT FROM '…'`).
 * The tests prove it equals the guards found in docs/migrations. An acknowledgement never bypasses a guard: it only sets
 * the value the guard itself reads, on the rollback connection, as the documented `SET rof.… = '…'` would. A release
 * accepts only the ids of its own migrations.
 */
export const ACKNOWLEDGEMENTS = {
  'directory-data':             { migration: '20261121001100_school_directory_model', setting: 'rof.m12_rollback', value: 'discard-directory-data' },
  'sync-history':               { migration: '20261121001200_school_directory_sync', setting: 'rof.m13_rollback', value: 'discard-sync-history' },
  'approval-history':           { migration: '20261121001300_school_directory_sync_approval', setting: 'rof.m14_rollback', value: 'discard-approval-history' },
  'teacher-applications':       { migration: '20261201000000_teacher_applications', setting: 'rof.teacher_applications_rollback', value: 'discard-teacher-applications' },
  'notification-outbox':        { migration: '20261202000000_notification_outbox', setting: 'rof.notification_outbox_rollback', value: 'discard-notification-outbox' },
  'student-olympiad-interests': { migration: '20261203000000_student_olympiad_interests', setting: 'rof.student_olympiad_interests_rollback', value: 'discard-student-olympiad-interests' },
  'registration-details':       { migration: '20261204000000_registration_details', setting: 'rof.registration_details_rollback', value: 'discard-registration-details' },
  'profile-pictures':           { migration: '20261205000000_avatar_file_purpose', setting: 'rof.avatar_file_purpose_rollback', value: 'discard-profile-pictures' },
  'account-states':             { migration: '20261206000000_account_states', setting: 'rof.account_states_rollback', value: 'discard-account-states' },
  'bulk-operations':            { migration: '20261207000000_bulk_operations', setting: 'rof.bulk_operations_rollback', value: 'discard-bulk-operations' },
  'form-settings':              { migration: '20261208000000_form_availability', setting: 'rof.form_availability_rollback', value: 'discard-form-settings' },
  'application-details':        { migration: '20261209000000_application_details', setting: 'rof.application_details_rollback', value: 'discard-application-details' },
  'teacher-student-access':     { migration: '20261210000000_teacher_student_access', setting: 'rof.teacher_student_rollback', value: 'discard-teacher-student-access' },
  'country-edits':              { migration: '20261211000000_countries_reference', setting: 'rof.countries_reference_rollback', value: 'discard-country-edits' },
  'primary-teachers':           { migration: '20261212000000_teacher_school_primary', setting: 'rof.teacher_school_primary_rollback', value: 'discard-primary-teachers' },
  'test-files':                 { migration: '20261220000000_test_file_purposes', setting: 'rof.test_file_purposes_rollback', value: 'discard-test-files' },
  'tests':                      { migration: '20261220000100_tests_core', setting: 'rof.tests_core_rollback', value: 'discard-tests' },
  'test-submissions':           { migration: '20261220000200_tests_submissions', setting: 'rof.tests_submissions_rollback', value: 'discard-submissions' },
  'test-marking':               { migration: '20261220000300_tests_marking', setting: 'rof.tests_marking_rollback', value: 'discard-marking' },
  'test-publications':          { migration: '20261220000400_tests_publishing', setting: 'rof.tests_publishing_rollback', value: 'discard-publications' },
  'genders':                    { migration: '20261221000000_registration_gender', setting: 'rof.registration_gender_rollback', value: 'discard-genders' },
  'home-places':                { migration: '20261221000100_home_location', setting: 'rof.home_location_rollback', value: 'discard-home-places' },
  'non-user-bulk-operations':   { migration: '20261222000000_bulk_operations_generic', setting: 'rof.bulk_operations_generic_rollback', value: 'discard-non-user-operations' },
  'olympiad-interest-other':    { migration: '20261223000000_olympiad_interest_other', setting: 'rof.olympiad_interest_other_rollback', value: 'discard-answers' },
  'resubmission-authorizations': { migration: '20261223000100_test_resubmission_lock', setting: 'rof.test_resubmission_lock_rollback', value: 'discard-authorizations' },
  'division-classifications':   { migration: '20261224000000_divisions_levels', setting: 'rof.divisions_levels_rollback', value: 'discard-classifications' },
  'reports-and-layouts':        { migration: '20261224000000_divisions_levels', setting: 'rof.divisions_levels_rollback_reports', value: 'discard-reports-and-layouts' },
  'sync-modes':                 { migration: '20261225000000_school_sync_mode', setting: 'rof.school_sync_mode_rollback', value: 'forget-modes' },
  'unlisted-school-details':    { migration: '20261225000100_teacher_unlisted_school', setting: 'rof.teacher_unlisted_school_rollback', value: 'discard-details' },
  'saved-filters':              { migration: '20261226000000_registration_data', setting: 'rof.registration_data_rollback', value: 'discard-saved-filters' },
  'coach-restrictions':         { migration: '20261227000000_coach_programme_access', setting: 'rof.coach_programme_access_rollback', value: 'discard-restrictions' },
  'form-email-verification':    { migration: '20261228000000_form_email_verification', setting: 'rof.form_email_verification_rollback', value: 'discard-verification-switches' },
  'subscribers':                { migration: '20261229000000_subscribers', setting: 'rof.subscribers_rollback', value: 'discard-subscribers' },
  'view-as-sessions':           { migration: '20261230000000_view_as', setting: 'rof.view_as_rollback', value: 'discard-sessions' },
  'bank-details':               { migration: '20261231000000_user_bank_details', setting: 'rof.bank_details_rollback', value: 'discard-bank-details' },
};

/** The acknowledgement ids of a release (those of its own migrations), sorted. */
export const releaseAcknowledgements = (release) =>
  Object.keys(ACKNOWLEDGEMENTS).filter((id) => release.owns(ACKNOWLEDGEMENTS[id].migration)).sort();

/**
 * Resolves `--acknowledge` values (pure; before any connection). Each must be exactly one id of the release's allow-list
 * (lower-case letters, digits and hyphens); an unknown, malformed, empty or repeated id refuses the whole command.
 * @returns {{ ok: true, acks: { id: string, setting: string, value: string }[] } | { ok: false, reason: string }}
 */
export function resolveAcknowledgements(values, release) {
  const allowed = releaseAcknowledgements(release);
  const list = `allowed for ${release.name}: ${allowed.join(', ') || 'none'}`;
  const acks = [];
  for (const id of values) {
    if (typeof id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) return { ok: false, reason: `--acknowledge "${id ?? ''}" is malformed (an id such as registration-details is expected; ${list}).` };
    if (!allowed.includes(id)) return { ok: false, reason: `--acknowledge "${id}" is not a guard of ${release.name}'s rollback files (${list}).` };
    if (acks.some((a) => a.id === id)) return { ok: false, reason: `--acknowledge "${id}" is given twice; give each acknowledgement once.` };
    acks.push({ id, setting: ACKNOWLEDGEMENTS[id].setting, value: ACKNOWLEDGEMENTS[id].value });
  }
  return { ok: true, acks };
}

/**
 * The levels-2026 release: Olympiad levels (owner, 2026-11-21) — Junior / Middle / Senior, separate from the grade —
 * after dec-2026. Listed explicitly — a migration added later is never part of it until it is appended here on purpose.
 */
export const LEVELS_2026_MIGRATIONS = [
  // Administrator-managed divisions = Olympiad levels: Division.code text, suggestedGrades, sortOrder; MIDDLE created;
  // Test.division text; TestSubmission.level; User.divisionManual; DivisionChange; the grade triggers.
  '20261224000000_divisions_levels',
];

/** What the levels-2026 migration creates (checked against its SQL by the tests); `rollback-history` refuses while any is left. */
export const LEVELS_2026_OBJECTS = {
  tables: ['DivisionChange', 'CourseDivision', 'TableLayout', 'CustomReport', 'CustomReportGrant'],
  enums: ['DivisionChangeSource'],
  columns: [['Division', 'sortOrder'], ['Division', 'suggestedGrades'], ['TestSubmission', 'level'], ['User', 'divisionManual']],
  triggers: ['student_division_from_grade', 'student_division_history', 'course_offered_in_divisions'],
  functions: ['division_for_grade', 'student_division_from_grade', 'student_division_history', 'course_offered_in_divisions'],
};

/**
 * The launch-2026 release: the seven migrations after levels-2026 (production holds every migration up to and including
 * 20261224000000_divisions_levels, read-only check 2026-11-23). Listed explicitly — a migration added later is never part
 * of it until it is appended here, with its MIGRATION_OBJECTS entry, its acknowledgements and its objects below, on purpose.
 */
export const LAUNCH_2026_MIGRATIONS = [
  // Directory sync "new schools only" (owner, 2026-11-22): SchoolSyncRun.mode FULL / NEW_ONLY, default FULL.
  '20261225000000_school_sync_mode',
  // Teacher registration "My school is not listed" (owner, 2026-11-22): five nullable proposedSchool* columns.
  '20261225000100_teacher_unlisted_school',
  // Registration data (owner, 2026-11-23): MentorRequest.userId (backfilled) and RegistrationSavedFilter.
  '20261226000000_registration_data',
  // Coach programme-wide access (owner, 2026-11-23): CoachCapability and CoachProgrammeRestriction (revoked marking
  // authorisations carried over).
  '20261227000000_coach_programme_access',
  // Activation per sign-up form (owner, 2026-11-23): FormAvailability.requireEmailVerification, default false.
  '20261228000000_form_email_verification',
  // News subscribers and mailings (owner, 2026-11-23): Subscriber, Mailing, EmailDelivery.subscriberId, four enums.
  '20261229000000_subscribers',
  // "View as" (owner, 2026-11-23): ViewAsSession — an administrator's read-only viewing session of a lower-ranked user.
  '20261230000000_view_as',
];

/** What the launch-2026 migrations create (checked against their SQL by the tests); `rollback-history` refuses while any is left. */
export const LAUNCH_2026_OBJECTS = {
  tables: ['RegistrationSavedFilter', 'CoachProgrammeRestriction', 'Subscriber', 'Mailing', 'ViewAsSession'],
  enums: ['SchoolSyncMode', 'CoachCapability', 'SubscriberKind', 'SubscriberSource', 'SubscriberStatus', 'MailingStatus'],
  columns: [
    ['SchoolSyncRun', 'mode'],
    ['TeacherApplication', 'proposedSchoolCode'], ['TeacherApplication', 'proposedSchoolCell'], ['TeacherApplication', 'proposedSchoolVillage'],
    ['TeacherApplication', 'proposedSchoolOwnership'], ['TeacherApplication', 'proposedSchoolAccommodation'],
    ['MentorRequest', 'userId'], ['FormAvailability', 'requireEmailVerification'], ['EmailDelivery', 'subscriberId'],
  ],
  triggers: [],
  functions: [],
};

/**
 * The banking-2026 release (owner, 2026-11-25): one migration after launch-2026 — UserBankDetails, the bank details of
 * Teachers (personal and school), Coaches and Head Coaches (personal only). Additive; production must hold launch-2026 first.
 */
export const BANKING_2026_MIGRATIONS = [
  '20261231000000_user_bank_details',
];

/** What the banking-2026 migration creates (checked against its SQL by the tests); `rollback-history` refuses while any is left. */
export const BANKING_2026_OBJECTS = {
  tables: ['UserBankDetails'],
  enums: [],
  columns: [],
  triggers: [],
  functions: [],
};

/**
 * Each release: `owns(name)` — the migration belongs to it; `last` — its last timestamp (a migration sorting after it
 * is never deployed by the kit for this release); the read-only SQL checks; and the rollback-history rule.
 */
export const RELEASES = {
  phase1: {
    label: 'Phase 1 (M1–M14)',
    count: PHASE1_COUNT,
    owns: (name) => PHASE1.test(name),
    last: LAST_PHASE1_TIMESTAMP,
    migrations: PHASE1_MIGRATIONS,
    precheck: 'scripts/release/phase1-precheck.sql',
    postcheck: 'scripts/release/phase1-postcheck.sql',
  },
  'post-phase1': {
    label: `post-Phase-1 (${POST_PHASE1_MIGRATIONS.length} migrations after M14)`,
    count: POST_PHASE1_MIGRATIONS.length,
    owns: (name) => POST_PHASE1_MIGRATIONS.includes(name),
    last: POST_PHASE1_MIGRATIONS.at(-1).slice(0, 14),
    precheck: 'scripts/release/post-phase1-precheck.sql',
    postcheck: 'scripts/release/post-phase1-postcheck.sql',
    migrations: POST_PHASE1_MIGRATIONS,
    objects: POST_PHASE1_OBJECTS,
    // The target must already hold Phase 1 (production today).
    requires: { label: 'Phase 1', count: PHASE1_COUNT, owns: (name) => PHASE1.test(name) },
  },
  'areas-2026': {
    label: `design areas (${AREAS_2026_MIGRATIONS.length} migrations after post-Phase-1)`,
    count: AREAS_2026_MIGRATIONS.length,
    owns: (name) => AREAS_2026_MIGRATIONS.includes(name),
    last: AREAS_2026_MIGRATIONS.at(-1).slice(0, 14),
    precheck: 'scripts/release/areas-2026-precheck.sql',
    postcheck: 'scripts/release/areas-2026-postcheck.sql',
    migrations: AREAS_2026_MIGRATIONS,
    objects: AREAS_2026_OBJECTS,
    // The target must already hold Phase 1 and the eleven post-Phase-1 migrations.
    requires: {
      label: 'Phase 1 and post-Phase-1', count: PHASE1_COUNT + POST_PHASE1_MIGRATIONS.length,
      owns: (name) => PHASE1.test(name) || POST_PHASE1_MIGRATIONS.includes(name),
    },
  },
  'late-2026': {
    label: `late 2026 (${LATE_2026_MIGRATIONS.length} migrations after the design areas)`,
    count: LATE_2026_MIGRATIONS.length,
    owns: (name) => LATE_2026_MIGRATIONS.includes(name),
    last: LATE_2026_MIGRATIONS.at(-1).slice(0, 14),
    precheck: 'scripts/release/late-2026-precheck.sql',
    postcheck: 'scripts/release/late-2026-postcheck.sql',
    migrations: LATE_2026_MIGRATIONS,
    objects: LATE_2026_OBJECTS,
    // The target must already hold Phase 1, post-Phase-1 and the design areas.
    requires: {
      label: 'Phase 1, post-Phase-1 and design areas', count: PHASE1_COUNT + POST_PHASE1_MIGRATIONS.length + AREAS_2026_MIGRATIONS.length,
      owns: (name) => PHASE1.test(name) || POST_PHASE1_MIGRATIONS.includes(name) || AREAS_2026_MIGRATIONS.includes(name),
    },
  },
  'dec-2026': {
    label: `dec 2026 (${DEC_2026_MIGRATIONS.length} migrations after late 2026)`,
    count: DEC_2026_MIGRATIONS.length,
    owns: (name) => DEC_2026_MIGRATIONS.includes(name),
    last: DEC_2026_MIGRATIONS.at(-1).slice(0, 14),
    precheck: 'scripts/release/dec-2026-precheck.sql',
    postcheck: 'scripts/release/dec-2026-postcheck.sql',
    migrations: DEC_2026_MIGRATIONS,
    objects: DEC_2026_OBJECTS,
    // The target must already hold Phase 1, post-Phase-1, the design areas and late-2026 (production since 2026-11-21).
    requires: {
      label: 'Phase 1, post-Phase-1, design areas and late 2026',
      count: PHASE1_COUNT + POST_PHASE1_MIGRATIONS.length + AREAS_2026_MIGRATIONS.length + LATE_2026_MIGRATIONS.length,
      owns: (name) => PHASE1.test(name) || POST_PHASE1_MIGRATIONS.includes(name) || AREAS_2026_MIGRATIONS.includes(name)
        || LATE_2026_MIGRATIONS.includes(name),
    },
  },
  'levels-2026': {
    label: `divisions and Olympiad levels (${LEVELS_2026_MIGRATIONS.length} migration after dec 2026)`,
    count: LEVELS_2026_MIGRATIONS.length,
    owns: (name) => LEVELS_2026_MIGRATIONS.includes(name),
    last: LEVELS_2026_MIGRATIONS.at(-1).slice(0, 14),
    precheck: 'scripts/release/levels-2026-precheck.sql',
    postcheck: 'scripts/release/levels-2026-postcheck.sql',
    migrations: LEVELS_2026_MIGRATIONS,
    objects: LEVELS_2026_OBJECTS,
    // The target must already hold every release before it, dec-2026 included.
    requires: {
      label: 'Phase 1, post-Phase-1, design areas, late 2026 and dec 2026',
      count: PHASE1_COUNT + POST_PHASE1_MIGRATIONS.length + AREAS_2026_MIGRATIONS.length + LATE_2026_MIGRATIONS.length + DEC_2026_MIGRATIONS.length,
      owns: (name) => PHASE1.test(name) || POST_PHASE1_MIGRATIONS.includes(name) || AREAS_2026_MIGRATIONS.includes(name)
        || LATE_2026_MIGRATIONS.includes(name) || DEC_2026_MIGRATIONS.includes(name),
    },
  },
  'launch-2026': {
    label: `the launch release (${LAUNCH_2026_MIGRATIONS.length} migrations after levels 2026)`,
    count: LAUNCH_2026_MIGRATIONS.length,
    owns: (name) => LAUNCH_2026_MIGRATIONS.includes(name),
    last: LAUNCH_2026_MIGRATIONS.at(-1).slice(0, 14),
    precheck: 'scripts/release/launch-2026-precheck.sql',
    postcheck: 'scripts/release/launch-2026-postcheck.sql',
    migrations: LAUNCH_2026_MIGRATIONS,
    objects: LAUNCH_2026_OBJECTS,
    // The target must already hold the six releases before it, levels-2026 included (production since 2026-11-22).
    requires: {
      label: 'Phase 1, post-Phase-1, design areas, late 2026, dec 2026 and levels 2026',
      count: PHASE1_COUNT + POST_PHASE1_MIGRATIONS.length + AREAS_2026_MIGRATIONS.length + LATE_2026_MIGRATIONS.length + DEC_2026_MIGRATIONS.length
        + LEVELS_2026_MIGRATIONS.length,
      owns: (name) => PHASE1.test(name) || POST_PHASE1_MIGRATIONS.includes(name) || AREAS_2026_MIGRATIONS.includes(name)
        || LATE_2026_MIGRATIONS.includes(name) || DEC_2026_MIGRATIONS.includes(name) || LEVELS_2026_MIGRATIONS.includes(name),
    },
  },
  'banking-2026': {
    label: `the banking release (${BANKING_2026_MIGRATIONS.length} migration after the launch release)`,
    count: BANKING_2026_MIGRATIONS.length,
    owns: (name) => BANKING_2026_MIGRATIONS.includes(name),
    last: BANKING_2026_MIGRATIONS.at(-1).slice(0, 14),
    precheck: 'scripts/release/banking-2026-precheck.sql',
    postcheck: 'scripts/release/banking-2026-postcheck.sql',
    migrations: BANKING_2026_MIGRATIONS,
    objects: BANKING_2026_OBJECTS,
    // The target must already hold the seven releases before it, launch-2026 included.
    requires: {
      label: 'Phase 1, post-Phase-1, design areas, late 2026, dec 2026, levels 2026 and the launch release',
      count: PHASE1_COUNT + POST_PHASE1_MIGRATIONS.length + AREAS_2026_MIGRATIONS.length + LATE_2026_MIGRATIONS.length + DEC_2026_MIGRATIONS.length
        + LEVELS_2026_MIGRATIONS.length + LAUNCH_2026_MIGRATIONS.length,
      owns: (name) => PHASE1.test(name) || POST_PHASE1_MIGRATIONS.includes(name) || AREAS_2026_MIGRATIONS.includes(name)
        || LATE_2026_MIGRATIONS.includes(name) || DEC_2026_MIGRATIONS.includes(name) || LEVELS_2026_MIGRATIONS.includes(name)
        || LAUNCH_2026_MIGRATIONS.includes(name),
    },
  },
};

export const RELEASE_NAMES = Object.keys(RELEASES);

/** The release named by `--release` (default `phase1`, the kit's original behaviour); null when unknown. */
export function releaseFrom(args) {
  const i = args.indexOf('--release');
  const name = i >= 0 ? args[i + 1] : 'phase1';
  return Object.hasOwn(RELEASES, name ?? '') ? { name, ...RELEASES[name] } : null;
}

/** Migration names (directories or history rows) that sort AFTER the release's last migration, sorted. */
export function afterRelease(release, names) {
  return names.filter((n) => n.slice(0, 14) > release.last).sort();
}

/**
 * The checkout must contain exactly the release's migrations (for post-Phase-1: all eleven, by name) and nothing after
 * them. Returns a refusal message, or null. `allowLater`: migrations after the release's last are accepted — only for the
 * commands that run nothing but the release's own files and checks (CHECKOUT_RELEASE_ONLY in rehearsal.mjs); `deploy`,
 * `diff` and `status` act on every migration of the checkout and keep the strict rule.
 */
export function checkoutProblem(release, dirs, { allowLater = false } = {}) {
  const later = afterRelease(release, dirs);
  if (later.length && !allowLater) {
    return `this checkout has ${later.length} migration(s) after ${release.label}'s last (${later.join(', ')}). `
      + `The kit deploys and rolls back exactly ${release.label}: run it from a checkout whose last migration is the release's last.`;
  }
  const mine = dirs.filter((d) => release.owns(d));
  if (mine.length !== release.count) {
    return `expected the ${release.count} migrations of ${release.label} in this checkout, found ${mine.length}.`;
  }
  return null;
}

/**
 * What a database looks like immediately BEFORE the post-Phase-1 release (production after Phase 1), derived from this
 * checkout alone: every repository migration up to and including M14, and the Prisma models without the tables that
 * the migrations after M14 create (`laterSql`: the eleven and anything later). They create tables and never drop or
 * rename one, so the subtraction is exact (checked by the tests).
 * @param {{ migDirs: string[], models: string[], laterSql: string[] }} input
 */
export function prePostPhase1Baseline({ migDirs, models, laterSql }) {
  const phase1 = migDirs.filter((d) => PHASE1.test(d));
  if (phase1.length !== PHASE1_COUNT) throw new Error(`expected ${PHASE1_COUNT} Phase 1 migrations, found ${phase1.length}`);
  const missing = POST_PHASE1_MIGRATIONS.filter((m) => !migDirs.includes(m));
  if (missing.length) throw new Error(`this checkout lacks post-Phase-1 migration(s): ${missing.join(', ')}`);
  const created = new Set(laterSql.flatMap((sql) => [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])));
  return { migrations: migDirs.filter((d) => d.slice(0, 14) <= LAST_PHASE1_TIMESTAMP), models: models.filter((m) => !created.has(m)) };
}

/**
 * The release's pre-switch files in docs/migrations (run BEFORE the code switch and before any rollback file, e.g.
 * 20261210000000_teacher_student_access.pre-switch.sql), newest first.
 */
export function releasePreSwitchFiles(release, names) {
  return names.filter((f) => f.endsWith('.pre-switch.sql') && release.owns(f.replace(/.pre-switch.sql$/, ''))).sort().reverse();
}

/** The release's rollback files in docs/migrations, newest first; exactly one per migration, or an error. */
export function releaseRollbackFiles(release, names) {
  const files = names.filter((f) => f.endsWith('.rollback.sql') && release.owns(f.replace(/\.rollback\.sql$/, ''))).sort().reverse();
  if (files.length !== release.count) {
    throw new Error(`expected ${release.count} ${release.label} rollback files in docs/migrations, found ${files.length}`);
  }
  return files;
}
