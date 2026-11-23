/**
 * Registration data (owner 2026-11-23): the FIELD ELIGIBILITY LAYER — which database columns a Super Administrator may
 * see, filter, sort, export and edit, decided column by column from rules, never from a hand-written list of fields.
 *
 * The columns themselves come from the database (field-catalogue.service.ts reads information_schema), so a column a
 * later migration adds to one of the SOURCES below appears on its own: visible, filterable, sortable, exportable, and
 * editable when it is plain data (text, number, date, yes/no, a choice). What it may NOT do is decided here:
 *
 *  1. NEVER exposed (not even its name): security and authentication data — passwords and their hashes, tokens, secrets,
 *     sign-in provider ids, lock-out counters — matched by name (SECRET_NAME) as well as listed, so a future
 *     `resetTokenHash` or `mfaSecret` stays hidden without anyone remembering to list it.
 *  2. Internal plumbing is not shown: foreign keys (a person sees the school's name, not its id), files, the cached
 *     leaderboard totals, the application's link to its account.
 *  3. Read-only: what the system keeps itself (ids, creation and update times, last sign-in, activation, application
 *     decisions, the current school claim — it belongs to the verification workflow).
 *  4. Edited through the existing rules (EDIT_VIA): identity, role, account status, grade, school, home place, date of
 *     birth and interests already have rules and side effects (sessions end on a role change, a school change moves the
 *     school claim, a grade change moves the Olympiad level, a new e-mail revokes e-mailed links …). Those fields are
 *     changed by the same code as before, never written around it.
 *  5. Personal contact data (PERSONAL_NAME: phones, date of birth, guardian, home place) is shown and exported to Super
 *     Administrators, but its VALUES are never copied into the audit log (the log says that it changed, by whom, when).
 */

/** Where a field comes from. Each is a table the person's registration wrote to. */
export type SourceKey = 'user' | 'school' | 'division' | 'coachApplication' | 'teacherApplication' | 'schoolClaim';

export interface SourceDef {
  key: SourceKey;
  /** The table (Prisma model) — also the PostgreSQL table name (no @@map in this schema). */
  model: 'User' | 'School' | 'Division' | 'MentorRequest' | 'TeacherApplication' | 'StudentSchoolAffiliation';
  /** Group heading in the column chooser, the filter builder and the edit form. */
  group: string;
  /**
   * How a user row reaches it: '' (the row itself), a to-one relation of User, or the current school claim (to-many,
   * the one claim not superseded).
   */
  relation: '' | 'school' | 'division' | 'mentorRequest' | 'teacherApplication' | 'schoolAffiliations';
  /** Its fields may be edited (generic path) — related lookup tables (schools, levels) never are from here. */
  editable: boolean;
}

export const SOURCES: Readonly<Record<SourceKey, SourceDef>> = {
  user: { key: 'user', model: 'User', group: 'Account and registration', relation: '', editable: true },
  school: { key: 'school', model: 'School', group: 'School', relation: 'school', editable: false },
  division: { key: 'division', model: 'Division', group: 'Olympiad level', relation: 'division', editable: false },
  coachApplication: { key: 'coachApplication', model: 'MentorRequest', group: 'Coach application', relation: 'mentorRequest', editable: true },
  teacherApplication: { key: 'teacherApplication', model: 'TeacherApplication', group: 'Teacher application', relation: 'teacherApplication', editable: true },
  schoolClaim: { key: 'schoolClaim', model: 'StudentSchoolAffiliation', group: 'School as entered by the student', relation: 'schoolAffiliations', editable: false },
};

/** The user categories (the tabs), which accounts each lists, and which sources it offers. */
export type CategoryKey = 'STUDENTS' | 'TEACHERS' | 'COACHES' | 'HEAD_COACHES' | 'ADMINS' | 'ALL';
export interface CategoryDef { key: CategoryKey; label: string; roles: readonly string[] | null; sources: readonly SourceKey[] }
export const CATEGORIES: Readonly<Record<CategoryKey, CategoryDef>> = {
  STUDENTS: { key: 'STUDENTS', label: 'Students', roles: ['STUDENT'], sources: ['user', 'school', 'division', 'schoolClaim'] },
  TEACHERS: { key: 'TEACHERS', label: 'Teachers', roles: ['TEACHER'], sources: ['user', 'teacherApplication'] },
  COACHES: { key: 'COACHES', label: 'Coaches', roles: ['MENTOR'], sources: ['user', 'coachApplication'] },
  HEAD_COACHES: { key: 'HEAD_COACHES', label: 'Head Coaches', roles: ['HEAD_COACH'], sources: ['user', 'coachApplication'] },
  ADMINS: { key: 'ADMINS', label: 'Administrators', roles: ['ADMIN', 'SUPER_ADMIN'], sources: ['user'] },
  ALL: { key: 'ALL', label: 'All users', roles: null, sources: ['user', 'school'] },
};
export const CATEGORY_KEYS = Object.keys(CATEGORIES) as CategoryKey[];

/** Security data, by name: never exposed, whatever the table. Matches future columns too. */
export const SECRET_NAME = /(password|passwd|hash|token|secret|salt|otp|mfa|totp|apikey|api_key|privatekey|private_key|recovery|provider|failedlogin|lockeduntil|sessions?$)/i;

/** Personal contact data, by name: shown to Super Administrators; values never written to the audit log. */
export const PERSONAL_NAME = /(phone|birth|guardian|^home|address|nationalid|national_id|passport)/i;

/** Columns not shown, per table (internal plumbing). Foreign keys (…Id) are hidden by rule, below. */
const HIDDEN: Readonly<Partial<Record<SourceDef['model'], readonly string[]>>> = {
  User: ['avatarUrl', 'points', 'problemsSolved', 'isActive', 'divisionManual', 'homeLocation'],
  School: ['nameNormalized', 'searchText', 'externalIdsHash'],
  MentorRequest: ['userId'],
  TeacherApplication: ['userId'],
  StudentSchoolAffiliation: ['studentId'],
};

/**
 * Columns of a source that duplicate the account's own column of the same name (the account is the record that is
 * kept up to date — an application's copy is history). Hidden from the application groups.
 */
export const DUPLICATES_ACCOUNT = true;

/** Read-only (kept by the system or by a workflow of its own). */
const READ_ONLY: Readonly<Partial<Record<SourceDef['model'], readonly string[]>>> = {
  User: ['id', 'createdAt', 'updatedAt', 'lastLoginAt', 'activatedAt', 'isApproved'],
  MentorRequest: ['id', 'status', 'createdAt', 'updatedAt'],
  TeacherApplication: ['id', 'status', 'createdAt', 'updatedAt', 'decidedAt', 'rejectionReason', 'decisionNote', 'schoolVerifiedAt'],
};

/** Read-only by name, any table: timestamps the system sets and decisions of a workflow. */
const READ_ONLY_NAME = /^(id|createdAt|updatedAt|deletedAt|decidedAt|decidedById|verifiedAt|supersededAt|revokedAt)$/;

/**
 * Fields with rules of their own: edited through the existing code, never the generic path.
 *  - 'account': PATCH /admin/users/:id rules (UsersService.update) — identity, role (step-up for Administrator roles),
 *    grade (moves the Olympiad level), school (moves the school claim), gender, home country and place, interests.
 *  - 'status': POST /admin/users/:id/status-changes (a reason; ends sessions).
 *  - 'dateOfBirth': PUT /admin/users/:id/date-of-birth (the registration rules; a reason; history kept).
 *  - 'olympiadLevel': PUT /admin/students/:id/olympiad-level (a reason; history kept).
 */
export type EditVia = 'direct' | 'account' | 'status' | 'dateOfBirth' | 'olympiadLevel' | 'none';
const USER_EDIT_VIA: Readonly<Record<string, EditVia>> = {
  firstName: 'account', lastName: 'account', username: 'account', email: 'account', role: 'account',
  gradeLevel: 'account', schoolId: 'account', gender: 'account',
  country: 'account', homeProvince: 'account', homeDistrict: 'account', homeSector: 'account',
  olympiadInterests: 'account', olympiadInterestOther: 'account',
  accountStatus: 'status', dateOfBirth: 'dateOfBirth', divisionId: 'olympiadLevel',
};

/** Foreign keys shown (as the related record's name, see LOOKUP) rather than hidden. */
const SHOWN_REFERENCES: Readonly<Record<string, { source: SourceKey; display: string }>> = {
  'User.schoolId': { source: 'school', display: 'name' },
  'User.divisionId': { source: 'division', display: 'name' },
};

/** Foreign keys whose own value means something to people (an ISO country code): shown as they are. */
const RAW_REFERENCES = new Set(['School.countryCode']);

/** Student-only account columns: not offered for other categories (always empty there). */
export const STUDENT_ONLY = new Set(['gradeLevel', 'divisionId', 'schoolId', 'dateOfBirth', 'guardianPhone']);

/** Better labels than the automatic ones (camelCase → words). Optional: a new column gets an automatic label. */
const LABELS: Readonly<Record<string, string>> = {
  'User.firstName': 'First name', 'User.lastName': 'Last name', 'User.email': 'Email address', 'User.username': 'Username',
  'User.role': 'Role', 'User.accountStatus': 'Account status', 'User.isApproved': 'Approved',
  'User.activatedAt': 'Activated on', 'User.lastLoginAt': 'Last sign-in', 'User.createdAt': 'Registered on', 'User.updatedAt': 'Last changed',
  'User.gradeLevel': 'Grade', 'User.divisionId': 'Olympiad level', 'User.schoolId': 'School',
  'User.phone': 'Phone number', 'User.country': 'Country', 'User.olympiadInterests': 'Olympiad subjects',
  'User.olympiadInterestOther': 'Other Olympiad', 'User.dateOfBirth': 'Date of birth', 'User.gender': 'Gender',
  'User.guardianPhone': 'Parent or guardian phone', 'User.homeProvince': 'Home province', 'User.homeDistrict': 'Home district',
  'User.homeSector': 'Home sector', 'User.id': 'Account ID',
  'School.name': 'School name', 'School.code': 'School code', 'School.province': 'School province', 'School.district': 'School district',
  'School.sector': 'School sector', 'School.cell': 'School cell', 'School.village': 'School village',
  'School.countryCode': 'School country', 'School.ownership': 'School ownership', 'School.accommodation': 'School: day or boarding',
  'School.isActive': 'School active', 'School.location': 'School location (as first entered)',
  'Division.name': 'Olympiad level name', 'Division.code': 'Olympiad level code',
  'MentorRequest.occupation': 'Occupation', 'MentorRequest.educationLevel': 'Education level', 'MentorRequest.affiliation': 'Institution or affiliation',
  'MentorRequest.expertise': 'Areas of expertise', 'MentorRequest.relevantExperience': 'Relevant experience',
  'MentorRequest.yearsOfExperience': 'Years of experience', 'MentorRequest.status': 'Application status', 'MentorRequest.createdAt': 'Applied on',
  'TeacherApplication.position': 'Position at the school', 'TeacherApplication.yearsOfExperience': 'Years of teaching experience',
  'TeacherApplication.schoolProvince': 'School province (as entered)', 'TeacherApplication.schoolDistrict': 'School district (as entered)',
  'TeacherApplication.schoolSector': 'School sector (as entered)', 'TeacherApplication.proposedSchoolName': 'Unlisted school name',
  'TeacherApplication.proposedSchoolCode': 'Unlisted school code', 'TeacherApplication.proposedSchoolCell': 'Unlisted school cell',
  'TeacherApplication.proposedSchoolVillage': 'Unlisted school village', 'TeacherApplication.proposedSchoolOwnership': 'Unlisted school ownership',
  'TeacherApplication.proposedSchoolAccommodation': 'Unlisted school: day or boarding', 'TeacherApplication.status': 'Application status',
  'TeacherApplication.createdAt': 'Applied on', 'TeacherApplication.decidedAt': 'Application decided on',
  'StudentSchoolAffiliation.claimedName': 'School name (as entered)', 'StudentSchoolAffiliation.claimedCountry': 'School country (as entered)',
  'StudentSchoolAffiliation.claimedProvince': 'School province (as entered)', 'StudentSchoolAffiliation.claimedDistrict': 'School district (as entered)',
  'StudentSchoolAffiliation.claimedSector': 'School sector (as entered)', 'StudentSchoolAffiliation.status': 'School verification',
};

/** "yearsOfExperience" → "Years of experience". */
export function humanize(name: string): string {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface ColumnFacts { source: SourceKey; column: string; isForeignKey: boolean; accountColumns: ReadonlySet<string> }

export interface Eligibility {
  /** Not offered at all. */
  hidden: boolean;
  label: string;
  editVia: EditVia;
  personal: boolean;
  /** A foreign key shown as the related record's name (filter and sort through it). */
  reference: { source: SourceKey; display: string } | null;
}

/** The decision for one column (see the file header). */
export function eligibility(f: ColumnFacts): Eligibility {
  const src = SOURCES[f.source];
  const id = `${src.model}.${f.column}`;
  const label = LABELS[id] ?? humanize(f.column);
  const personal = PERSONAL_NAME.test(f.column);
  const hiddenResult: Eligibility = { hidden: true, label, editVia: 'none', personal, reference: null };
  if (SECRET_NAME.test(f.column)) return hiddenResult;
  if (HIDDEN[src.model]?.includes(f.column)) return hiddenResult;
  // An application's copy of an account column (name, e-mail, country …): the account's own value is the one kept.
  if (DUPLICATES_ACCOUNT && f.source !== 'user' && src.editable && f.accountColumns.has(f.column) && !['id', 'createdAt', 'updatedAt', 'status'].includes(f.column)) {
    return hiddenResult;
  }
  const reference = SHOWN_REFERENCES[id] ?? null;
  if (f.isForeignKey && !reference && !RAW_REFERENCES.has(id)) return hiddenResult;
  let editVia: EditVia = src.editable ? 'direct' : 'none';
  if (f.source === 'user' && USER_EDIT_VIA[f.column]) editVia = USER_EDIT_VIA[f.column];
  if (READ_ONLY[src.model]?.includes(f.column) || READ_ONLY_NAME.test(f.column)) editVia = 'none';
  return { hidden: false, label, editVia, personal, reference };
}
