/**
 * Report sources for Administrators (owner 2026-11-25: "reports with any data"): schools, learning, applications and
 * administration data, each from its own table. Scope "admin": only Administrators and the Super Admin may use them
 * (banking information: the Super Admin only). Personal data are protected fields (see report-sources.ts).
 *
 * Every field is built by `pathField`: a column of the source's table, or of a related one along a path
 * (e.g. ['student', 'school', 'name']), with its type's filters (text: is / is not / contains / empty; list: is / is
 * not / any of; date and number: from / to; yes-no: is) and sorting.
 */
import {
  ActivityType, CourseEnrollmentStatus, MembershipSource, MentorRequestStatus, Role, SchoolAccommodation, SchoolSource,
  SubmissionStatus, SubscriberKind, SubscriberSource, SubscriberStatus, TeacherApplicationStatus, TestSubmissionStatus,
} from '../generated/prisma/enums.js';
import { bankingSummary } from '../banking/banking-rules.js';
import type { FieldDef, FieldType, FilterOp, SourceDef } from './report-sources.js';

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
const asDate = (v: unknown): Date | null => {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const asNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return String(v ?? '').trim() !== '' && Number.isFinite(n) ? n : null;
};
const ins = { mode: 'insensitive' as const };
/** Matches no row, on any table (Prisma: an empty OR is false). */
const NONE = { OR: [] };
const ALL = {};
const masked = (n: string | null | undefined) => (n ? (n.length <= 4 ? '••••' : `•••• ${n.slice(-4)}`) : null);

/** { a: { b: { c: leaf } } } for the path ['a', 'b', 'c']. */
const nest = (path: readonly string[], leaf: unknown): object =>
  path.slice(0, -1).reduceRight<object>((acc, k) => ({ [k]: acc }), { [path[path.length - 1]]: leaf });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a row of any source's table
const read = (r: any, path: readonly string[]): unknown => path.reduce((o, k) => (o == null ? null : o[k]), r);

interface PathOpts {
  key: string;
  label: string;
  path: readonly string[];
  type: Exclude<FieldType, 'list'>;
  values?: readonly string[];
  /** The column itself may be empty (NULL). */
  nullable?: boolean;
  /**
   * The first `via` segments of the path are an optional relation (e.g. 2 for ['student', 'school', 'name']: a student
   * may have no school). "Is empty" then also matches rows without it; sorting puts them last only when the column
   * itself may be empty (the database refuses that on a required column).
   */
  via?: number;
  /** Not filterable / not sortable (e.g. a computed value). */
  filterable?: boolean;
  sortable?: boolean;
  protected?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a row of any source's table
  display?: (r: any) => string | number | boolean | Date | null;
}

function pathField(o: PathOpts): FieldDef {
  const { path } = o;
  // "Is empty": the optional relation is absent, or the column is empty (NULL, or '' for text).
  const empties: object[] = [];
  const present: object[] = [];
  if (o.via) { empties.push(nest(path.slice(0, o.via), { is: null })); present.push(nest(path.slice(0, o.via), { isNot: null })); }
  if (o.nullable) { empties.push(nest(path, null)); present.push({ NOT: nest(path, null) }); }
  if (o.type === 'text') { empties.push(nest(path, '')); present.push({ NOT: nest(path, '') }); }
  const emptyWhere = empties.length ? { OR: empties } : NONE;
  const notEmptyWhere = present.length ? { AND: present } : ALL;
  const where = (op: FilterOp, v: unknown): object | null => {
    if (op === 'isEmpty') return emptyWhere;
    if (op === 'isNotEmpty') return notEmptyWhere;
    switch (o.type) {
      case 'text': {
        const s = String(v ?? '');
        if (op === 'eq') return nest(path, { equals: s, ...ins });
        if (op === 'neq') return { NOT: nest(path, { equals: s, ...ins }) };
        if (op === 'contains') return nest(path, { contains: s, ...ins });
        return null;
      }
      case 'enum': {
        const list = asList(v).filter((x) => o.values!.includes(x));
        if (op === 'eq') return list[0] ? nest(path, list[0]) : null;
        if (op === 'neq') return list[0] ? { NOT: nest(path, list[0]) } : null;
        if (op === 'in') return list.length ? nest(path, { in: list }) : null;
        return null;
      }
      case 'date': {
        const d = asDate(v);
        if (op === 'gte') return d ? nest(path, { gte: d }) : null;
        if (op === 'lte') return d ? nest(path, { lte: d }) : null;
        return null;
      }
      case 'number': {
        const n = asNumber(v);
        if (op === 'eq') return n !== null ? nest(path, n) : null;
        if (op === 'gte') return n !== null ? nest(path, { gte: n }) : null;
        if (op === 'lte') return n !== null ? nest(path, { lte: n }) : null;
        return null;
      }
      case 'boolean':
        return op === 'eq' && (v === true || v === false || v === 'true' || v === 'false') ? nest(path, v === true || v === 'true') : null;
    }
    return null;
  };
  return {
    key: o.key, label: o.label, type: o.type, values: o.values, protected: o.protected,
    value: (r) => (o.display ? o.display(r) : (read(r, path) as string | number | boolean | Date | null) ?? null),
    ...(o.filterable !== false && { where }),
    // Empty last only where the column itself may be empty (the database refuses it on a required column).
    ...(o.sortable !== false && { orderBy: (dir: 'asc' | 'desc') => [nest(path, o.nullable ? { sort: dir, nulls: 'last' } : dir)] }),
  };
}

const vals = (e: Record<string, string>) => Object.values(e);
const text = (key: string, label: string, path: readonly string[], nullable = false, via?: number) => pathField({ key, label, path, type: 'text', nullable, via });
const date = (key: string, label: string, path: readonly string[], nullable = false) => pathField({ key, label, path, type: 'date', nullable });
const num = (key: string, label: string, path: readonly string[], nullable = false, via?: number) => pathField({ key, label, path, type: 'number', nullable, via });
const choice = (key: string, label: string, path: readonly string[], values: readonly string[], nullable = false) => pathField({ key, label, path, type: 'enum', values, nullable });
const yesNo = (key: string, label: string, path: readonly string[]) => pathField({ key, label, path, type: 'boolean' });
/** A person (student, applicant, account) along `rel`: full name (sorted by last name), e-mail. */
const personFields = (rel: string, who: string) => [
  pathField({ key: `${rel}Name`, label: `${who} name`, path: [rel, 'lastName'], type: 'text', display: (r) => (r[rel] ? `${r[rel].firstName} ${r[rel].lastName}`.trim() : null) }),
  text(`${rel}Email`, `${who} e-mail`, [rel, 'email']),
];
const PERSON = { select: { firstName: true, lastName: true, email: true, role: true, school: { select: { name: true, district: true } } } };
const admin = (d: Omit<SourceDef, 'scope'>): SourceDef => ({ ...d, scope: 'admin' });

export const ADMIN_SOURCES: Readonly<Record<string, SourceDef>> = {
  // ─── Schools ───────────────────────────────────────────────────────────────
  SCHOOLS: admin({
    key: 'SCHOOLS', label: 'Schools', group: 'Schools', model: 'school', rows: {},
    select: {
      id: true, name: true, code: true, countryCode: true, province: true, district: true, sector: true, cell: true, village: true,
      ownership: true, accommodation: true, isActive: true, source: true, createdAt: true, lastVerifiedAt: true,
      _count: { select: { students: { where: { role: 'STUDENT' } }, teachers: { where: { isActive: true } } } },
    },
    defaultOrder: [{ name: 'asc' }],
    fields: [
      text('name', 'School name', ['name']), text('code', 'School code', ['code'], true), text('country', 'Country', ['countryCode']),
      text('province', 'Province', ['province'], true), text('district', 'District', ['district'], true), text('sector', 'Sector', ['sector'], true),
      text('cell', 'Cell', ['cell'], true), text('village', 'Village', ['village'], true), text('ownership', 'Ownership', ['ownership'], true),
      choice('accommodation', 'Day / boarding', ['accommodation'], vals(SchoolAccommodation), true),
      yesNo('active', 'Active', ['isActive']), choice('source', 'Source', ['source'], vals(SchoolSource)),
      date('createdAt', 'Added on', ['createdAt']), date('lastVerifiedAt', 'Last verified', ['lastVerifiedAt'], true),
      pathField({ key: 'students', label: 'Number of students', path: ['_count', 'students'], type: 'number', filterable: false, sortable: false }),
      pathField({ key: 'teachers', label: 'Number of teachers', path: ['_count', 'teachers'], type: 'number', filterable: false, sortable: false }),
    ],
  }),
  SCHOOL_TEACHERS: admin({
    key: 'SCHOOL_TEACHERS', label: 'School teachers', group: 'Schools', model: 'teacherSchoolAssignment', rows: {},
    select: { id: true, isActive: true, createdAt: true, school: { select: { name: true, code: true, district: true } }, teacher: PERSON },
    defaultOrder: [{ school: { name: 'asc' } }],
    fields: [
      text('schoolName', 'School name', ['school', 'name']), text('schoolCode', 'School code', ['school', 'code'], true),
      text('schoolDistrict', 'School district', ['school', 'district'], true), ...personFields('teacher', 'Teacher'),
      yesNo('active', 'Active', ['isActive']), date('createdAt', 'Since', ['createdAt']),
    ],
  }),

  // ─── Learning ──────────────────────────────────────────────────────────────
  TEST_RESULTS: admin({
    key: 'TEST_RESULTS', label: 'Test results', group: 'Learning', model: 'testSubmission', rows: {},
    select: {
      id: true, status: true, level: true, firstSubmittedAt: true, lastSubmittedAt: true, publishedAt: true, versionCount: true,
      test: { select: { title: true, division: true, maxMarks: true, discipline: { select: { name: true } } } },
      student: PERSON, finalMarking: { select: { totalMarks: true } },
    },
    defaultOrder: [{ lastSubmittedAt: { sort: 'desc', nulls: 'last' } }],
    fields: [
      ...personFields('student', 'Student'), text('studentSchool', 'School', ['student', 'school', 'name'], false, 2),
      text('studentDistrict', 'School district', ['student', 'school', 'district'], true, 2),
      text('test', 'Test', ['test', 'title']), text('subject', 'Subject', ['test', 'discipline', 'name']), text('division', 'Division', ['test', 'division']),
      text('level', 'Level', ['level'], true), choice('status', 'Status', ['status'], vals(TestSubmissionStatus)),
      num('marks', 'Marks', ['finalMarking', 'totalMarks'], true, 1), num('maxMarks', 'Out of', ['test', 'maxMarks']),
      num('versions', 'Times submitted', ['versionCount']), date('firstSubmittedAt', 'First submitted', ['firstSubmittedAt'], true),
      date('lastSubmittedAt', 'Last submitted', ['lastSubmittedAt'], true), date('publishedAt', 'Results published', ['publishedAt'], true),
    ],
  }),
  ASSIGNMENT_GRADES: admin({
    key: 'ASSIGNMENT_GRADES', label: 'Assignment grades', group: 'Learning', model: 'submission', rows: {},
    select: {
      id: true, status: true, isLate: true, submittedAt: true, pointsAwarded: true, publishedAt: true, revisionCount: true,
      assignment: { select: { title: true, maximumMarks: true, deadline: true, course: { select: { title: true } }, division: { select: { name: true } } } },
      student: PERSON,
    },
    defaultOrder: [{ submittedAt: { sort: 'desc', nulls: 'last' } }],
    fields: [
      ...personFields('student', 'Student'), text('studentSchool', 'School', ['student', 'school', 'name'], false, 2),
      text('assignment', 'Assignment', ['assignment', 'title']), text('course', 'Course', ['assignment', 'course', 'title']),
      text('division', 'Division', ['assignment', 'division', 'name']), choice('status', 'Status', ['status'], vals(SubmissionStatus)),
      num('points', 'Points awarded', ['pointsAwarded']), num('maximumMarks', 'Out of', ['assignment', 'maximumMarks']),
      yesNo('late', 'Late', ['isLate']), num('revisions', 'Revisions', ['revisionCount']),
      date('submittedAt', 'Submitted', ['submittedAt'], true), date('deadline', 'Deadline', ['assignment', 'deadline']), date('publishedAt', 'Grade published', ['publishedAt'], true),
    ],
  }),
  ENROLMENTS: admin({
    key: 'ENROLMENTS', label: 'Course enrolments', group: 'Learning', model: 'courseEnrollment', rows: {},
    select: { id: true, status: true, firstOpenedAt: true, lastOpenedAt: true, completedAt: true, course: { select: { title: true, code: true } }, student: PERSON },
    defaultOrder: [{ lastOpenedAt: 'desc' }],
    fields: [
      ...personFields('student', 'Student'), text('studentSchool', 'School', ['student', 'school', 'name'], false, 2),
      text('course', 'Course', ['course', 'title']), text('courseCode', 'Course code', ['course', 'code']),
      choice('status', 'Status', ['status'], vals(CourseEnrollmentStatus)), date('firstOpenedAt', 'First opened', ['firstOpenedAt']),
      date('lastOpenedAt', 'Last opened', ['lastOpenedAt']), date('completedAt', 'Completed', ['completedAt'], true),
    ],
  }),

  // ─── Applications ──────────────────────────────────────────────────────────
  TEACHER_APPLICATIONS: admin({
    key: 'TEACHER_APPLICATIONS', label: 'Teacher applications', group: 'Applications', model: 'teacherApplication', rows: {},
    select: {
      id: true, firstName: true, lastName: true, username: true, email: true, phone: true, country: true, gender: true, status: true,
      schoolProvince: true, schoolDistrict: true, proposedSchoolName: true, position: true, homeProvince: true, homeDistrict: true, homeSector: true,
      createdAt: true, decidedAt: true, school: { select: { name: true, code: true } },
    },
    defaultOrder: [{ createdAt: 'desc' }],
    fields: [
      pathField({ key: 'name', label: 'Applicant name', path: ['lastName'], type: 'text', display: (r) => `${r.firstName} ${r.lastName}`.trim() }),
      text('email', 'E-mail', ['email']), text('username', 'Username', ['username']), text('country', 'Country', ['country']),
      choice('status', 'Status', ['status'], vals(TeacherApplicationStatus)),
      pathField({ key: 'school', label: 'School', path: ['school', 'name'], type: 'text', via: 1, display: (r) => r.school?.name ?? r.proposedSchoolName ?? null }),
      text('schoolProvince', 'School province', ['schoolProvince']), text('schoolDistrict', 'School district', ['schoolDistrict']),
      text('position', 'Position', ['position'], true), date('createdAt', 'Applied on', ['createdAt']), date('decidedAt', 'Decided on', ['decidedAt'], true),
      { ...text('phone', 'Phone number', ['phone']), protected: true },
      { ...text('homeProvince', 'Home province', ['homeProvince'], true), protected: true },
      { ...text('homeDistrict', 'Home district', ['homeDistrict'], true), protected: true },
      { ...text('homeSector', 'Home sector', ['homeSector'], true), protected: true },
    ],
  }),
  COACH_APPLICATIONS: admin({
    key: 'COACH_APPLICATIONS', label: 'Coach applications', group: 'Applications', model: 'mentorRequest', rows: {},
    select: {
      id: true, firstName: true, lastName: true, username: true, email: true, phone: true, country: true, occupation: true, educationLevel: true,
      affiliation: true, yearsOfExperience: true, status: true, homeProvince: true, homeDistrict: true, homeSector: true, createdAt: true,
    },
    defaultOrder: [{ createdAt: 'desc' }],
    fields: [
      pathField({ key: 'name', label: 'Applicant name', path: ['lastName'], type: 'text', display: (r) => `${r.firstName} ${r.lastName}`.trim() }),
      text('email', 'E-mail', ['email']), text('username', 'Username', ['username']), text('country', 'Country', ['country'], true),
      choice('status', 'Status', ['status'], vals(MentorRequestStatus)), text('occupation', 'Occupation', ['occupation'], true),
      text('affiliation', 'Affiliation', ['affiliation'], true), num('experience', 'Years of experience', ['yearsOfExperience'], true),
      date('createdAt', 'Applied on', ['createdAt']),
      { ...text('phone', 'Phone number', ['phone'], true), protected: true },
      { ...text('homeProvince', 'Home province', ['homeProvince'], true), protected: true },
      { ...text('homeDistrict', 'Home district', ['homeDistrict'], true), protected: true },
      { ...text('homeSector', 'Home sector', ['homeSector'], true), protected: true },
    ],
  }),

  // ─── Administration ────────────────────────────────────────────────────────
  BANKING: admin({
    key: 'BANKING', label: 'Banking information', group: 'Administration', model: 'userBankDetails', superAdminOnly: true, rows: {}, idField: 'userId',
    select: {
      userId: true, personalAccountName: true, personalBankName: true, personalAccountNumber: true,
      schoolAccountName: true, schoolBankName: true, schoolAccountNumber: true, updatedAt: true, user: PERSON,
    },
    defaultOrder: [{ updatedAt: 'desc' }],
    fields: [
      ...personFields('user', 'Person'), choice('role', 'Role', ['user', 'role'], ['TEACHER', 'MENTOR', 'HEAD_COACH']),
      pathField({ key: 'status', label: 'Status', path: ['updatedAt'], type: 'text', filterable: false, sortable: false,
        display: (r) => bankingSummary(r.user.role, r).status }),
      text('personalAccountName', 'Personal account name', ['personalAccountName'], true), text('personalBankName', 'Personal bank', ['personalBankName'], true),
      pathField({ key: 'personalAccountNumber', label: 'Personal account number (masked)', path: ['personalAccountNumber'], type: 'text', filterable: false, sortable: false, protected: true, display: (r) => masked(r.personalAccountNumber) }),
      text('schoolAccountName', 'School account name', ['schoolAccountName'], true), text('schoolBankName', 'School bank', ['schoolBankName'], true),
      pathField({ key: 'schoolAccountNumber', label: 'School account number (masked)', path: ['schoolAccountNumber'], type: 'text', filterable: false, sortable: false, protected: true, display: (r) => masked(r.schoolAccountNumber) }),
      date('updatedAt', 'Last changed', ['updatedAt']),
    ],
  }),
  PROGRAMME_MEMBERS: admin({
    key: 'PROGRAMME_MEMBERS', label: 'Programmes and members', group: 'Administration', model: 'programmeMembership', rows: {},
    select: { id: true, isActive: true, source: true, createdAt: true, endedAt: true, discipline: { select: { name: true } }, user: PERSON },
    defaultOrder: [{ discipline: { name: 'asc' } }],
    fields: [
      text('programme', 'Programme', ['discipline', 'name']), ...personFields('user', 'Member'),
      choice('role', 'Role', ['user', 'role'], vals(Role)), yesNo('active', 'Active', ['isActive']),
      choice('source', 'Added by', ['source'], vals(MembershipSource)), date('createdAt', 'Joined', ['createdAt']), date('endedAt', 'Left', ['endedAt'], true),
    ],
  }),
  SUBSCRIBERS: admin({
    key: 'SUBSCRIBERS', label: 'News subscribers', group: 'Administration', model: 'subscriber', rows: {},
    select: { id: true, email: true, fullName: true, kind: true, country: true, source: true, status: true, subscribedAt: true, unsubscribedAt: true },
    defaultOrder: [{ subscribedAt: 'desc' }],
    fields: [
      text('email', 'E-mail', ['email']), text('name', 'Name', ['fullName'], true), choice('kind', 'Kind', ['kind'], vals(SubscriberKind), true),
      text('country', 'Country', ['country'], true), choice('source', 'Source', ['source'], vals(SubscriberSource)),
      choice('status', 'Status', ['status'], vals(SubscriberStatus)), date('subscribedAt', 'Subscribed', ['subscribedAt']),
      date('unsubscribedAt', 'Unsubscribed', ['unsubscribedAt'], true),
    ],
  }),
  ACTIVITY: admin({
    key: 'ACTIVITY', label: 'Activity log', group: 'Administration', model: 'activityLog', rows: {},
    select: { id: true, type: true, createdAt: true, course: { select: { title: true } }, user: PERSON },
    defaultOrder: [{ createdAt: 'desc' }],
    fields: [
      ...personFields('user', 'Person'), choice('role', 'Role', ['user', 'role'], vals(Role)),
      choice('type', 'Activity', ['type'], vals(ActivityType)), text('course', 'Course', ['course', 'title'], false, 1), date('createdAt', 'When', ['createdAt']),
    ],
  }),
};
