/**
 * Custom report sources (owner 2026-11-22): what a report may list, field by field. Every row is a user account; each
 * source fixes which accounts (students, coaches, teachers, every user) and which fields may be chosen, filtered and
 * sorted. Personal data (phone numbers, a guardian's phone, date of birth, home place, bank account numbers) are
 * PROTECTED fields (owner 2026-11-25): only the Super Admin may add them to a report, every run or download that shows
 * them is recorded in the audit log, bank account numbers are always masked (last 4), and anyone else who runs a shared
 * report sees them blank. Passwords and tokens are a field of no source.
 *
 * Sources (owner 2026-11-25): the people lists (scope "people": each viewer within their own scope) and, for
 * Administrators only (scope "admin"), schools, learning, applications and administration data — each with its own
 * table (`model`), rows and fields (report-sources-admin.ts).
 */
import type { Prisma } from '../generated/prisma/client.js';
import { ADMIN_SOURCES } from './report-sources-admin.js';

export type FieldType = 'text' | 'enum' | 'date' | 'boolean' | 'list' | 'number';
export type FilterOp = 'eq' | 'neq' | 'in' | 'contains' | 'gte' | 'lte' | 'isEmpty' | 'isNotEmpty';

/** A row as read from the database (ROW_SELECT). */
export interface Row {
  id: string; firstName: string; lastName: string; username: string | null; email: string; role: string; accountStatus: string;
  createdAt: Date; lastLoginAt: Date | null; country: string | null; gender: string | null; gradeLevel: string | null;
  olympiadInterests: string[]; olympiadInterestOther: string | null;
  school: { name: string; province: string | null; district: string | null } | null;
  division: { code: string; name: string } | null;
  teacherSchools: Array<{ school: { name: string } }>;
  mentorAssignments: Array<{ course: { title: string }; division: { name: string } }>;
  _count: { mentorAssignments: number };
  phone: string | null; guardianPhone: string | null; dateOfBirth: Date | null;
  homeProvince: string | null; homeDistrict: string | null; homeSector: string | null;
  bankDetails: { personalAccountNumber: string | null; schoolAccountNumber: string | null } | null;
}

export const ROW_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true, role: true, accountStatus: true, createdAt: true, lastLoginAt: true,
  country: true, gender: true, gradeLevel: true, olympiadInterests: true, olympiadInterestOther: true,
  school: { select: { name: true, province: true, district: true } },
  division: { select: { code: true, name: true } },
  teacherSchools: { where: { isActive: true }, select: { school: { select: { name: true } } } },
  mentorAssignments: { where: { isActive: true }, select: { course: { select: { title: true } }, division: { select: { name: true } } } },
  _count: { select: { mentorAssignments: { where: { isActive: true } } } },
  // Protected fields (shown only to the Super Admin; see the file header).
  phone: true, guardianPhone: true, dateOfBirth: true, homeProvince: true, homeDistrict: true, homeSector: true,
  bankDetails: { select: { personalAccountNumber: true, schoolAccountNumber: true } },
} as const satisfies Prisma.UserSelect;

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** enum fields: the allowed values. */
  values?: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each source reads its own table's row
  value: (r: any) => string | number | boolean | Date | null;
  /** Filter: a where clause (of the source's table) for (op, value); absent: not filterable. */
  where?: (op: FilterOp, v: unknown) => object | null;
  /** Sort: absent: not sortable. */
  orderBy?: (dir: 'asc' | 'desc') => object[];
  /** Personal data: only the Super Admin may add it; blank for anyone else (see the file header). */
  protected?: boolean;
}

const SUBJECTS = ['MATHEMATICS', 'PHYSICS', 'COMPUTING'] as const;
const STATUSES = ['ACTIVE', 'DEACTIVATED', 'SUSPENDED', 'ARCHIVED'] as const;
const GRADES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const;
const ROLES = ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN', 'SUPER_ADMIN'] as const;

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
const asDate = (v: unknown): Date | null => {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const ins = { mode: 'insensitive' as const };

/**
 * Columns that may be empty (NULL) in the database. Only these may be tested for NULL or sorted with "empty last":
 * Prisma refuses both on a required column, which surfaced as a server error (owner report 2026-11-25).
 */
const NULLABLE = new Set(['country', 'gradeLevel', 'gender', 'lastLoginAt', 'phone', 'guardianPhone', 'dateOfBirth', 'homeProvince', 'homeDistrict', 'homeSector']);
/** A filter that matches no row / every row (for "is empty" / "is not empty" on a column that is never empty). */
const NONE: Prisma.UserWhereInput = { id: { in: [] } };
const ALL: Prisma.UserWhereInput = {};
/** Sort by a User column: empty values last where the column may be empty. */
const sortBy = (column: string, dir: 'asc' | 'desc') =>
  [{ [column]: NULLABLE.has(column) ? { sort: dir, nulls: 'last' } : dir } as Prisma.UserOrderByWithRelationInput];

/** Text column of the User row. */
function text(key: string, label: string, column: 'firstName' | 'lastName' | 'username' | 'email' | 'country' | 'phone' | 'guardianPhone' | 'homeProvince' | 'homeDistrict' | 'homeSector'): FieldDef {
  return {
    key, label, type: 'text', value: (r) => r[column] ?? null,
    where: (op, v) => {
      const s = String(v ?? '');
      switch (op) {
        case 'eq': return { [column]: { equals: s, ...ins } };
        case 'neq': return { NOT: { [column]: { equals: s, ...ins } } };
        case 'contains': return { [column]: { contains: s, ...ins } };
        case 'isEmpty': return NULLABLE.has(column) ? { OR: [{ [column]: null }, { [column]: '' }] } : { [column]: '' };
        case 'isNotEmpty': return NULLABLE.has(column) ? { AND: [{ [column]: { not: null } }, { NOT: { [column]: '' } }] } : { NOT: { [column]: '' } };
        default: return null;
      }
    },
    orderBy: (dir) => sortBy(column, dir),
  };
}

/** Enum column of the User row. */
function enumField(key: string, label: string, column: 'role' | 'accountStatus' | 'gradeLevel' | 'gender', values: readonly string[]): FieldDef {
  return {
    key, label, type: 'enum', values, value: (r) => (r as unknown as Record<string, string | null>)[column] ?? null,
    where: (op, v) => {
      const list = asList(v).filter((x) => values.includes(x));
      switch (op) {
        case 'eq': return list[0] ? { [column]: list[0] } : null;
        case 'neq': return list[0] ? { NOT: { [column]: list[0] } } : null;
        case 'in': return list.length ? { [column]: { in: list } } : null;
        case 'isEmpty': return NULLABLE.has(column) ? { [column]: null } : NONE;
        case 'isNotEmpty': return NULLABLE.has(column) ? { [column]: { not: null } } : ALL;
        default: return null;
      }
    },
    orderBy: (dir) => sortBy(column, dir),
  };
}

/** Date column of the User row. */
function dateField(key: string, label: string, column: 'createdAt' | 'lastLoginAt' | 'dateOfBirth'): FieldDef {
  return {
    key, label, type: 'date', value: (r) => r[column],
    where: (op, v) => {
      const d = asDate(v);
      switch (op) {
        case 'gte': return d ? { [column]: { gte: d } } : null;
        case 'lte': return d ? { [column]: { lte: d } } : null;
        case 'isEmpty': return NULLABLE.has(column) ? { [column]: null } : NONE;
        case 'isNotEmpty': return NULLABLE.has(column) ? { [column]: { not: null } } : ALL;
        default: return null;
      }
    },
    orderBy: (dir) => sortBy(column, dir),
  };
}

const F = {
  fullName: { key: 'fullName', label: 'Full name', type: 'text', value: (r: Row) => `${r.firstName} ${r.lastName}`.trim(),
    where: (op: FilterOp, v: unknown) => (op === 'contains' ? { OR: [{ firstName: { contains: String(v ?? ''), ...ins } }, { lastName: { contains: String(v ?? ''), ...ins } }] } : null),
    orderBy: (dir: 'asc' | 'desc') => [{ lastName: dir }, { firstName: dir }] } satisfies FieldDef,
  firstName: text('firstName', 'First name', 'firstName'),
  lastName: text('lastName', 'Last name', 'lastName'),
  username: text('username', 'Username', 'username'),
  email: text('email', 'Email', 'email'),
  country: text('country', 'Country', 'country'),
  role: enumField('role', 'Role', 'role', ROLES),
  accountStatus: enumField('accountStatus', 'Account status', 'accountStatus', STATUSES),
  gender: enumField('gender', 'Gender', 'gender', ['FEMALE', 'MALE']),
  grade: enumField('grade', 'Grade', 'gradeLevel', GRADES),
  registeredAt: dateField('registeredAt', 'Registration date', 'createdAt'),
  lastLoginAt: dateField('lastLoginAt', 'Last login', 'lastLoginAt'),
  neverLoggedIn: { key: 'neverLoggedIn', label: 'Never logged in', type: 'boolean', value: (r: Row) => r.lastLoginAt === null,
    where: (op: FilterOp, v: unknown) => (op === 'eq' ? (v === true || v === 'true' ? { lastLoginAt: null } : { lastLoginAt: { not: null } }) : null) } satisfies FieldDef,
  school: { key: 'school', label: 'School', type: 'text', value: (r: Row) => r.school?.name ?? null,
    where: (op: FilterOp, v: unknown) => (op === 'contains' ? { school: { name: { contains: String(v ?? ''), ...ins } } }
      : op === 'eq' ? { school: { name: { equals: String(v ?? ''), ...ins } } } : op === 'isEmpty' ? { schoolId: null } : op === 'isNotEmpty' ? { schoolId: { not: null } } : null),
    orderBy: (dir: 'asc' | 'desc') => [{ school: { name: dir } }] } satisfies FieldDef,
  province: { key: 'province', label: 'School province', type: 'text', value: (r: Row) => r.school?.province ?? null,
    where: (op: FilterOp, v: unknown) => (op === 'eq' ? { school: { province: { equals: String(v ?? ''), ...ins } } } : op === 'contains' ? { school: { province: { contains: String(v ?? ''), ...ins } } } : null),
    orderBy: (dir: 'asc' | 'desc') => [{ school: { province: dir } }] } satisfies FieldDef,
  district: { key: 'district', label: 'School district', type: 'text', value: (r: Row) => r.school?.district ?? null,
    where: (op: FilterOp, v: unknown) => (op === 'eq' ? { school: { district: { equals: String(v ?? ''), ...ins } } } : op === 'contains' ? { school: { district: { contains: String(v ?? ''), ...ins } } } : null),
    orderBy: (dir: 'asc' | 'desc') => [{ school: { district: dir } }] } satisfies FieldDef,
  olympiadLevel: { key: 'olympiadLevel', label: 'Olympiad level', type: 'text', value: (r: Row) => r.division?.name ?? null,
    where: (op: FilterOp, v: unknown) => (op === 'eq' ? { division: { code: String(v ?? '') } } : op === 'in' ? { division: { code: { in: asList(v) } } } : null),
    orderBy: (dir: 'asc' | 'desc') => [{ division: { sortOrder: dir } }] } satisfies FieldDef,
  subjects: { key: 'subjects', label: 'Olympiad subjects', type: 'list', values: SUBJECTS,
    value: (r: Row) => [...r.olympiadInterests, ...(r.olympiadInterestOther ? [r.olympiadInterestOther] : [])].join(', ') || null,
    where: (op: FilterOp, v: unknown) => {
      const list = asList(v).filter((x) => (SUBJECTS as readonly string[]).includes(x)) as Array<(typeof SUBJECTS)[number]>;
      return op === 'in' && list.length ? { olympiadInterests: { hasSome: list } } : op === 'eq' && list[0] ? { olympiadInterests: { has: list[0] } }
        : op === 'isEmpty' ? { olympiadInterests: { isEmpty: true } } : null;
    } } satisfies FieldDef,
  teacherSchools: { key: 'teacherSchools', label: 'Schools (teacher)', type: 'text', value: (r: Row) => r.teacherSchools.map((t) => t.school.name).join(', ') || null } satisfies FieldDef,
  coachCourses: { key: 'coachCourses', label: 'Courses and divisions taught', type: 'text',
    value: (r: Row) => r.mentorAssignments.map((m) => `${m.course.title} (${m.division.name})`).join(', ') || null } satisfies FieldDef,
  coachAssignments: { key: 'coachAssignments', label: 'Number of course assignments', type: 'text', value: (r: Row) => r._count.mentorAssignments } satisfies FieldDef,
};

/** A bank account number for a report: the last 4 only, always (even for the Super Admin). */
export const maskedNumber = (n: string | null | undefined) => (n ? (n.length <= 4 ? '••••' : `•••• ${n.slice(-4)}`) : null);

/** Protected personal fields (Super Admin only; see the file header). */
const P = {
  phone: { ...text('phone', 'Phone number', 'phone'), protected: true },
  guardianPhone: { ...text('guardianPhone', "Guardian's phone", 'guardianPhone'), protected: true },
  dateOfBirth: { ...dateField('dateOfBirth', 'Date of birth', 'dateOfBirth'), protected: true },
  homeProvince: { ...text('homeProvince', 'Home province', 'homeProvince'), protected: true },
  homeDistrict: { ...text('homeDistrict', 'Home district', 'homeDistrict'), protected: true },
  homeSector: { ...text('homeSector', 'Home sector', 'homeSector'), protected: true },
  personalAccount: { key: 'personalAccount', label: 'Personal bank account number (masked)', type: 'text', protected: true,
    value: (r: Row) => maskedNumber(r.bankDetails?.personalAccountNumber) } satisfies FieldDef,
  schoolAccount: { key: 'schoolAccount', label: 'School bank account number (masked)', type: 'text', protected: true,
    value: (r: Row) => maskedNumber(r.bankDetails?.schoolAccountNumber) } satisfies FieldDef,
};

export type SourceGroup = 'People' | 'Schools' | 'Learning' | 'Applications' | 'Administration';

export interface SourceDef {
  key: string;
  label: string;
  group: SourceGroup;
  /** The table (Prisma model) the rows come from. */
  model: string;
  /** What is read of each row. */
  select: object;
  /** Which rows of the table. */
  rows: object;
  /** "people": each viewer within their own scope of accounts; "admin": Administrators only. */
  scope: 'people' | 'admin';
  /** Only the Super Admin may use this source (e.g. banking information). */
  superAdminOnly?: boolean;
  /** The order when the report has none (then by the key column). */
  defaultOrder: object[];
  /** The table's key column (default "id"): the last sort key, so pages never overlap. */
  idField?: string;
  fields: readonly FieldDef[];
}

const COMMON = [F.fullName, F.firstName, F.lastName, F.username, F.email, F.accountStatus, F.registeredAt, F.lastLoginAt, F.neverLoggedIn, F.country, F.gender];
const PERSONAL = [P.phone, P.dateOfBirth, P.homeProvince, P.homeDistrict, P.homeSector];
const people = (key: string, label: string, rows: Prisma.UserWhereInput, fields: readonly FieldDef[]): SourceDef => ({
  key, label, group: 'People', model: 'user', select: ROW_SELECT, rows, scope: 'people',
  defaultOrder: [{ lastName: 'asc' }, { firstName: 'asc' }], fields,
});

export const SOURCES: Readonly<Record<string, SourceDef>> = {
  STUDENTS: people('STUDENTS', 'Students', { role: 'STUDENT' },
    [...COMMON, F.school, F.province, F.district, F.grade, F.olympiadLevel, F.subjects, ...PERSONAL, P.guardianPhone]),
  COACHES: people('COACHES', 'Coaches and Head Coaches', { role: { in: ['MENTOR', 'HEAD_COACH'] } },
    [...COMMON, F.role, F.subjects, F.coachCourses, F.coachAssignments, ...PERSONAL, P.personalAccount]),
  TEACHERS: people('TEACHERS', 'Teachers', { role: 'TEACHER' }, [...COMMON, F.teacherSchools, F.subjects, ...PERSONAL, P.personalAccount, P.schoolAccount]),
  USERS: people('USERS', 'All users', {}, [...COMMON, F.role, F.school, ...PERSONAL]),
  ...ADMIN_SOURCES,
};

export const FILTER_OPS: readonly FilterOp[] = ['eq', 'neq', 'in', 'contains', 'gte', 'lte', 'isEmpty', 'isNotEmpty'];

export interface ReportDefinition {
  source: string;
  columns: string[];
  filters: Array<{ field: string; op: FilterOp; value?: unknown }>;
  sort: Array<{ field: string; dir: 'asc' | 'desc' }>;
}

/**
 * Problems of a report definition (empty: valid): known source, its fields only, filterable / sortable ones. With the
 * author's role: a source for Administrators only, and protected fields only for the Super Admin.
 */
export function definitionProblems(d: ReportDefinition, role?: string): string[] {
  const src = SOURCES[d.source];
  if (!src) return [`unknown source ${d.source}`];
  const field = (k: string) => src.fields.find((f) => f.key === k);
  const out: string[] = [];
  if (role !== undefined) {
    if (src.superAdminOnly && role !== 'SUPER_ADMIN') out.push(`${src.label}: only the Super Admin can use this data`);
    else if (src.scope === 'admin' && role !== 'ADMIN' && role !== 'SUPER_ADMIN') out.push(`${src.label}: only Administrators can use this data`);
    const used = new Set([...d.columns, ...d.filters.map((f) => f.field), ...d.sort.map((s) => s.field)]);
    if (role !== 'SUPER_ADMIN') for (const k of used) if (field(k)?.protected) out.push(`${field(k)!.label}: only the Super Admin can add personal data`);
  }
  if (!d.columns.length) out.push('choose at least one column');
  for (const c of d.columns) if (!field(c)) out.push(`unknown column ${c}`);
  if (new Set(d.columns).size !== d.columns.length) out.push('a column appears twice');
  for (const f of d.filters) {
    const def = field(f.field);
    if (!def?.where) out.push(`${f.field} cannot be filtered`);
    else if (!FILTER_OPS.includes(f.op) || def.where(f.op, f.value) === null) out.push(`${f.field}: the condition ${f.op} with this value is not supported`);
  }
  for (const s of d.sort) if (!field(s.field)?.orderBy) out.push(`${s.field} cannot be sorted`);
  return out;
}

/** The where clause of a (valid) definition, inside the viewer's scope. */
export function definitionWhere(d: ReportDefinition, scope: object): object {
  const src = SOURCES[d.source];
  const field = (k: string) => src.fields.find((f) => f.key === k)!;
  return { AND: [src.rows, scope, ...d.filters.map((f) => field(f.field).where!(f.op, f.value)!)] };
}

/** The order of a (valid) definition; the source's default order, then id. */
export function definitionOrder(d: ReportDefinition): object[] {
  const src = SOURCES[d.source];
  const by = d.sort.flatMap((s) => src.fields.find((f) => f.key === s.field)!.orderBy!(s.dir));
  return [...(by.length ? by : src.defaultOrder), { [src.idField ?? 'id']: 'asc' }];
}

/** Whether the definition shows protected (personal) fields: columns, filters or sort. */
export function usesProtected(d: ReportDefinition): boolean {
  const src = SOURCES[d.source];
  const keys = [...d.columns, ...d.filters.map((f) => f.field), ...d.sort.map((s) => s.field)];
  return keys.some((k) => src?.fields.find((f) => f.key === k)?.protected);
}

/**
 * A row's cells for the chosen columns (dates as ISO text). `showProtected` false (anyone but the Super Admin): the
 * protected columns are blank.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each source reads its own table's row
export function cells(d: ReportDefinition, r: any, showProtected = false): Array<string | number | boolean | null> {
  const src = SOURCES[d.source];
  return d.columns.map((c) => {
    const f = src.fields.find((x) => x.key === c)!;
    if (f.protected && !showProtected) return null;
    const v = f.value(r);
    return v instanceof Date ? v.toISOString() : v;
  });
}
