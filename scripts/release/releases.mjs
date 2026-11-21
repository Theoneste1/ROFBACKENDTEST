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
  tables: ['DivisionChange', 'CourseDivision'],
  enums: ['DivisionChangeSource'],
  columns: [['Division', 'sortOrder'], ['Division', 'suggestedGrades'], ['TestSubmission', 'level'], ['User', 'divisionManual']],
  triggers: ['student_division_from_grade', 'student_division_history', 'course_offered_in_divisions'],
  functions: ['division_for_grade', 'student_division_from_grade', 'student_division_history', 'course_offered_in_divisions'],
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
 * The checkout must contain exactly the release's migrations (for post-Phase-1: all nine, by name) and nothing after
 * them. Returns a refusal message, or null.
 */
export function checkoutProblem(release, dirs) {
  const later = afterRelease(release, dirs);
  if (later.length) {
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
