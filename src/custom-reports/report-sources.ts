/**
 * Custom report sources (owner 2026-11-22): what a report may list, field by field. Every row is a user account; each
 * source fixes which accounts (students, coaches, teachers, every user) and which fields may be chosen, filtered and
 * sorted. Sensitive personal data — phone numbers, guardian contacts, date of birth, home address, passwords, tokens —
 * is NOT a field of any source, so no report can show it, whoever runs it.
 */
import type { Prisma } from '../generated/prisma/client.js';

export type FieldType = 'text' | 'enum' | 'date' | 'boolean' | 'list';
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
}

export const ROW_SELECT = {
  id: true, firstName: true, lastName: true, username: true, email: true, role: true, accountStatus: true, createdAt: true, lastLoginAt: true,
  country: true, gender: true, gradeLevel: true, olympiadInterests: true, olympiadInterestOther: true,
  school: { select: { name: true, province: true, district: true } },
  division: { select: { code: true, name: true } },
  teacherSchools: { where: { isActive: true }, select: { school: { select: { name: true } } } },
  mentorAssignments: { where: { isActive: true }, select: { course: { select: { title: true } }, division: { select: { name: true } } } },
  _count: { select: { mentorAssignments: { where: { isActive: true } } } },
} as const satisfies Prisma.UserSelect;

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** enum fields: the allowed values. */
  values?: readonly string[];
  value: (r: Row) => string | number | boolean | Date | null;
  /** Filter: a where clause for (op, value); absent: not filterable. */
  where?: (op: FilterOp, v: unknown) => Prisma.UserWhereInput | null;
  /** Sort: absent: not sortable. */
  orderBy?: (dir: 'asc' | 'desc') => Prisma.UserOrderByWithRelationInput[];
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
const NULLABLE = new Set(['country', 'gradeLevel', 'gender', 'lastLoginAt']);
/** A filter that matches no row / every row (for "is empty" / "is not empty" on a column that is never empty). */
const NONE: Prisma.UserWhereInput = { id: { in: [] } };
const ALL: Prisma.UserWhereInput = {};
/** Sort by a User column: empty values last where the column may be empty. */
const sortBy = (column: string, dir: 'asc' | 'desc') =>
  [{ [column]: NULLABLE.has(column) ? { sort: dir, nulls: 'last' } : dir } as Prisma.UserOrderByWithRelationInput];

/** Text column of the User row. */
function text(key: string, label: string, column: 'firstName' | 'lastName' | 'username' | 'email' | 'country'): FieldDef {
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
function dateField(key: string, label: string, column: 'createdAt' | 'lastLoginAt'): FieldDef {
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

export interface SourceDef { key: string; label: string; rows: Prisma.UserWhereInput; fields: readonly FieldDef[] }

const COMMON = [F.fullName, F.firstName, F.lastName, F.username, F.email, F.accountStatus, F.registeredAt, F.lastLoginAt, F.neverLoggedIn, F.country, F.gender];

export const SOURCES: Readonly<Record<string, SourceDef>> = {
  STUDENTS: { key: 'STUDENTS', label: 'Students', rows: { role: 'STUDENT' },
    fields: [...COMMON, F.school, F.province, F.district, F.grade, F.olympiadLevel, F.subjects] },
  COACHES: { key: 'COACHES', label: 'Coaches and Head Coaches', rows: { role: { in: ['MENTOR', 'HEAD_COACH'] } },
    fields: [...COMMON, F.role, F.subjects, F.coachCourses, F.coachAssignments] },
  TEACHERS: { key: 'TEACHERS', label: 'Teachers', rows: { role: 'TEACHER' }, fields: [...COMMON, F.teacherSchools, F.subjects] },
  USERS: { key: 'USERS', label: 'All users', rows: {}, fields: [...COMMON, F.role, F.school] },
};

export const FILTER_OPS: readonly FilterOp[] = ['eq', 'neq', 'in', 'contains', 'gte', 'lte', 'isEmpty', 'isNotEmpty'];

export interface ReportDefinition {
  source: string;
  columns: string[];
  filters: Array<{ field: string; op: FilterOp; value?: unknown }>;
  sort: Array<{ field: string; dir: 'asc' | 'desc' }>;
}

/** Problems of a report definition (empty: valid): known source, its fields only, filterable / sortable ones. */
export function definitionProblems(d: ReportDefinition): string[] {
  const src = SOURCES[d.source];
  if (!src) return [`unknown source ${d.source}`];
  const field = (k: string) => src.fields.find((f) => f.key === k);
  const out: string[] = [];
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
export function definitionWhere(d: ReportDefinition, scope: Prisma.UserWhereInput): Prisma.UserWhereInput {
  const src = SOURCES[d.source];
  const field = (k: string) => src.fields.find((f) => f.key === k)!;
  return { AND: [src.rows, scope, ...d.filters.map((f) => field(f.field).where!(f.op, f.value)!)] };
}

/** The order of a (valid) definition; by name, then id, by default. */
export function definitionOrder(d: ReportDefinition): Prisma.UserOrderByWithRelationInput[] {
  const src = SOURCES[d.source];
  const by = d.sort.flatMap((s) => src.fields.find((f) => f.key === s.field)!.orderBy!(s.dir));
  return [...(by.length ? by : [{ lastName: 'asc' as const }, { firstName: 'asc' as const }]), { id: 'asc' }];
}

/** A row's cells for the chosen columns (dates as ISO text). */
export function cells(d: ReportDefinition, r: Row): Array<string | number | boolean | null> {
  const src = SOURCES[d.source];
  return d.columns.map((c) => {
    const v = src.fields.find((f) => f.key === c)!.value(r);
    return v instanceof Date ? v.toISOString() : v;
  });
}
