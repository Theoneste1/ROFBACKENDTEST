import { describe, expect, it } from 'vitest';

import type { Field } from './field-catalogue.service.js';
import { eligibility, humanize, type SourceKey } from './field-policy.js';
import { compileFilter, compileSelect, compileSort, exportText, OPERATORS, QueryProblem, searchWhere, valueOf } from './query-compiler.js';
import { categoryOfRole, parsePlainValue } from './registration-data.service.js';

const account = new Set(['id', 'firstName', 'lastName', 'email', 'username', 'country', 'gender', 'phone', 'olympiadInterests', 'homeProvince', 'createdAt', 'updatedAt']);
const el = (source: SourceKey, column: string, isForeignKey = false) => eligibility({ source, column, isForeignKey, accountColumns: account });

const field = (over: Partial<Field> & Pick<Field, 'key' | 'type'>): Field => ({
  source: 'user', column: over.key.split('.')[1], label: humanize(over.key.split('.')[1]), group: 'Account and registration',
  values: null, valueLabels: null, nullable: true, integer: false, maxLength: null, editVia: 'direct', personal: false,
  filterable: true, sortable: true, reference: null, ...over,
});

const F = {
  first: field({ key: 'user.firstName', type: 'text', nullable: false, editVia: 'account' }),
  phone: field({ key: 'user.phone', type: 'text', personal: true }),
  years: field({ key: 'coachApplication.yearsOfExperience', source: 'coachApplication', type: 'number', integer: true, group: 'Coach application' }),
  edu: field({ key: 'coachApplication.educationLevel', source: 'coachApplication', type: 'enum', values: ['BACHELOR', 'MASTER'], valueLabels: { BACHELOR: 'Bachelor', MASTER: 'Master' } }),
  dob: field({ key: 'user.dateOfBirth', type: 'date', personal: true, editVia: 'dateOfBirth' }),
  created: field({ key: 'user.createdAt', type: 'datetime', nullable: false, editVia: 'none' }),
  approved: field({ key: 'user.isApproved', type: 'boolean', nullable: false, editVia: 'none' }),
  subjects: field({ key: 'user.olympiadInterests', type: 'enumList', values: ['MATHEMATICS', 'PHYSICS', 'COMPUTING'], nullable: false, sortable: false }),
  school: field({ key: 'user.schoolId', type: 'text', reference: 'school', editVia: 'account' }),
  level: field({ key: 'user.divisionId', type: 'enum', reference: 'division', values: ['Junior', 'Senior'], editVia: 'olympiadLevel' }),
  claimed: field({ key: 'schoolClaim.claimedName', source: 'schoolClaim', type: 'text', sortable: false, editVia: 'none' }),
};
const ALL = Object.values(F);
const where = (conditions: unknown[], combinator: 'AND' | 'OR' = 'AND') => compileFilter({ combinator, conditions: conditions as never }, ALL);
const inner = (conditions: unknown[]) => (where(conditions) as { AND: unknown[] }).AND[0];

describe('registration data — the eligibility layer', () => {
  it('security data is never offered, by name — including columns that do not exist yet', () => {
    for (const c of ['passwordHash', 'providerId', 'failedLoginCount', 'lockedUntil', 'tokensValidAfter', 'resetTokenHash', 'mfaSecret', 'apiKey', 'otpCode', 'recoveryCodes', 'salt']) {
      expect(el('user', c).hidden, c).toBe(true);
    }
    expect(el('coachApplication', 'passwordHash').hidden).toBe(true);
    expect(el('teacherApplication', 'passwordHash').hidden).toBe(true);
  });

  it('a NEW plain column is offered automatically: visible, filterable, editable, with a label made from its name', () => {
    const e = el('user', 'shirtSize');
    expect(e).toMatchObject({ hidden: false, label: 'Shirt size', editVia: 'direct', personal: false });
    expect(el('coachApplication', 'linkedinProfile')).toMatchObject({ hidden: false, editVia: 'direct' });
    expect(el('user', 'emergencyPhone')).toMatchObject({ hidden: false, personal: true });   // personal by name: values never audited
  });

  it('internal plumbing is hidden; system values are read-only; rule-bearing fields go through their own rules', () => {
    for (const c of ['avatarUrl', 'points', 'problemsSolved', 'avatarFileId']) expect(el('user', c, c.endsWith('Id')).hidden, c).toBe(true);
    expect(el('user', 'someNewRelationId', true).hidden).toBe(true);           // a foreign key: never its raw id
    expect(el('user', 'schoolId', true)).toMatchObject({ hidden: false, editVia: 'account', reference: { source: 'school' } });
    expect(el('user', 'divisionId', true)).toMatchObject({ hidden: false, editVia: 'olympiadLevel' });
    for (const c of ['id', 'createdAt', 'updatedAt', 'lastLoginAt', 'activatedAt']) expect(el('user', c).editVia, c).toBe('none');
    expect(el('user', 'accountStatus').editVia).toBe('status');
    expect(el('user', 'dateOfBirth')).toMatchObject({ editVia: 'dateOfBirth', personal: true });
    for (const c of ['email', 'username', 'role', 'gradeLevel', 'country', 'olympiadInterests']) expect(el('user', c).editVia, c).toBe('account');
    expect(el('teacherApplication', 'decidedAt').editVia).toBe('none');
    expect(el('teacherApplication', 'status').editVia).toBe('none');
    expect(el('schoolClaim', 'claimedName').editVia).toBe('none');             // the verification workflow's own record
    expect(el('school', 'name').editVia).toBe('none');                         // a related lookup is never edited from here
  });

  it("an application's copy of an account column is hidden (the account is the record kept up to date)", () => {
    for (const c of ['firstName', 'email', 'country', 'gender', 'phone', 'olympiadInterests', 'homeProvince']) expect(el('coachApplication', c).hidden, c).toBe(true);
    expect(el('coachApplication', 'occupation').hidden).toBe(false);
    expect(el('coachApplication', 'status')).toMatchObject({ hidden: false, editVia: 'none', label: 'Application status' });
    expect(el('teacherApplication', 'position').hidden).toBe(false);
  });

  it('categories by role', () => {
    expect(['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN', 'SUPER_ADMIN', 'X'].map(categoryOfRole))
      .toEqual(['STUDENTS', 'TEACHERS', 'COACHES', 'HEAD_COACHES', 'ADMINS', 'ADMINS', 'ALL']);
  });
});

describe('registration data — filters', () => {
  it('every type has its conditions, and every condition compiles', () => {
    expect(OPERATORS.text).toEqual(expect.arrayContaining(['contains', 'notContains', 'eq', 'startsWith', 'isEmpty', 'isNotEmpty']));
    expect(OPERATORS.number).toEqual(expect.arrayContaining(['eq', 'gt', 'lt', 'between']));
    expect(OPERATORS.date).toEqual(expect.arrayContaining(['before', 'after', 'between']));
    expect(OPERATORS.enum).toEqual(expect.arrayContaining(['in', 'notIn']));
    expect(OPERATORS.boolean).toEqual(expect.arrayContaining(['isTrue', 'isFalse']));
  });

  it('text: insensitive; "does not contain" and "is not" also match empty values', () => {
    expect(inner([{ field: 'user.firstName', operator: 'contains', value: ' ana ' }])).toEqual({ firstName: { contains: 'ana', mode: 'insensitive' } });
    expect(inner([{ field: 'user.firstName', operator: 'startsWith', value: 'A' }])).toEqual({ firstName: { startsWith: 'A', mode: 'insensitive' } });
    // firstName is required: NOT alone; phone is nullable: NULL included explicitly.
    expect(inner([{ field: 'user.firstName', operator: 'notContains', value: 'x' }])).toEqual({ NOT: { firstName: { contains: 'x', mode: 'insensitive' } } });
    expect(inner([{ field: 'user.phone', operator: 'neq', value: '+250' }])).toEqual({ OR: [{ phone: null }, { NOT: { phone: { equals: '+250', mode: 'insensitive' } } }] });
    expect(inner([{ field: 'user.phone', operator: 'isEmpty' }])).toEqual({ OR: [{ phone: null }, { phone: '' }] });
    expect(inner([{ field: 'user.phone', operator: 'isNotEmpty' }])).toEqual({ NOT: { OR: [{ phone: null }, { phone: '' }] } });
  });

  it('numbers, dates (Kigali days), yes / no, choices and lists', () => {
    expect(inner([{ field: 'coachApplication.yearsOfExperience', operator: 'gt', value: '5' }])).toEqual({ mentorRequest: { is: { yearsOfExperience: { gt: 5 } } } });
    expect(inner([{ field: 'coachApplication.yearsOfExperience', operator: 'between', value: 10, value2: 2 }])).toEqual({ mentorRequest: { is: { yearsOfExperience: { gte: 2, lte: 10 } } } });
    // A date column compares dates; a date-time column the day in Kigali (UTC+2).
    expect(inner([{ field: 'user.dateOfBirth', operator: 'before', value: '2010-01-01' }])).toEqual({ dateOfBirth: { lt: new Date('2010-01-01T00:00:00Z') } });
    expect(inner([{ field: 'user.createdAt', operator: 'on', value: '2026-11-20' }]))
      .toEqual({ createdAt: { gte: new Date('2026-11-19T22:00:00Z'), lt: new Date('2026-11-20T22:00:00Z') } });
    expect(inner([{ field: 'user.createdAt', operator: 'between', value: '2026-11-21', value2: '2026-11-20' }]))
      .toEqual({ createdAt: { gte: new Date('2026-11-19T22:00:00Z'), lt: new Date('2026-11-21T22:00:00Z') } });
    expect(inner([{ field: 'user.isApproved', operator: 'isFalse' }])).toEqual({ isApproved: { equals: false } });
    expect(inner([{ field: 'coachApplication.educationLevel', operator: 'in', value: ['MASTER'] }])).toEqual({ mentorRequest: { is: { educationLevel: { in: ['MASTER'] } } } });
    expect(inner([{ field: 'user.olympiadInterests', operator: 'hasAll', value: ['MATHEMATICS', 'PHYSICS'] }])).toEqual({ olympiadInterests: { hasEvery: ['MATHEMATICS', 'PHYSICS'] } });
    expect(inner([{ field: 'user.olympiadInterests', operator: 'hasNone', value: ['PHYSICS'] }])).toEqual({ NOT: { olympiadInterests: { hasSome: ['PHYSICS'] } } });
    expect(inner([{ field: 'user.olympiadInterests', operator: 'isEmpty' }])).toEqual({ OR: [{ olympiadInterests: { isEmpty: true } }] });
  });

  it('references filter by the related name; the current school claim through "some, not superseded"', () => {
    expect(inner([{ field: 'user.schoolId', operator: 'contains', value: 'Lycée' }])).toEqual({ school: { is: { name: { contains: 'Lycée', mode: 'insensitive' } } } });
    expect(inner([{ field: 'user.divisionId', operator: 'in', value: ['Junior'] }])).toEqual({ division: { is: { name: { in: ['Junior'] } } } });
    expect(inner([{ field: 'user.schoolId', operator: 'isEmpty' }])).toEqual({ OR: [{ school: { is: null } }, { school: { is: { name: null } } }, { school: { is: { name: '' } } }] });
    expect(inner([{ field: 'schoolClaim.claimedName', operator: 'contains', value: 'GS' }]))
      .toEqual({ schoolAffiliations: { some: { supersededAt: null, claimedName: { contains: 'GS', mode: 'insensitive' } } } });
  });

  it('AND / OR groups nest', () => {
    const w = compileFilter({ combinator: 'AND', conditions: [
      { field: 'user.firstName', operator: 'eq', value: 'Ana' },
      { combinator: 'OR', conditions: [{ field: 'user.isApproved', operator: 'isTrue' }, { field: 'user.phone', operator: 'isNotEmpty' }] },
    ] }, ALL);
    expect(w).toEqual({ AND: [{ firstName: { equals: 'Ana', mode: 'insensitive' } }, { OR: [{ isApproved: { equals: true } }, { NOT: { OR: [{ phone: null }, { phone: '' }] } }] }] });
    expect(compileFilter({ combinator: 'OR', conditions: [] }, ALL)).toEqual({});
    expect(compileFilter(null, ALL)).toEqual({});
  });

  it('refuses — in plain words, every problem — unknown fields, wrong conditions, bad values, too deep or too many', () => {
    const problems = (g: unknown) => {
      try { compileFilter(g as never, ALL); return []; } catch (e) { expect(e).toBeInstanceOf(QueryProblem); return (e as QueryProblem).problems; }
    };
    expect(problems({ combinator: 'AND', conditions: [{ field: 'user.passwordHash', operator: 'eq', value: 'x' }] })).toEqual(['The field "user.passwordHash" is not available here.']);
    expect(problems({ combinator: 'AND', conditions: [{ field: 'user.firstName', operator: 'gt', value: 'x' }] })[0]).toMatch(/cannot be filtered with "is greater than"/);
    expect(problems({ combinator: 'AND', conditions: [{ field: 'coachApplication.yearsOfExperience', operator: 'eq', value: 'ten' }] })[0]).toMatch(/value is missing or not valid/);
    expect(problems({ combinator: 'AND', conditions: [{ field: 'coachApplication.yearsOfExperience', operator: 'eq', value: 2.5 }] })).toHaveLength(1);   // whole numbers
    expect(problems({ combinator: 'AND', conditions: [{ field: 'user.dateOfBirth', operator: 'on', value: '2010-02-30' }] })).toHaveLength(1);
    expect(problems({ combinator: 'AND', conditions: [{ field: 'coachApplication.educationLevel', operator: 'in', value: ["MASTER'; DROP TABLE"] }] })).toHaveLength(1);
    expect(problems({ combinator: 'XOR', conditions: [] })[0]).toMatch(/all \(AND\) or any \(OR\)/);
    const deep = { combinator: 'AND', conditions: [{ combinator: 'AND', conditions: [{ combinator: 'AND', conditions: [{ combinator: 'AND', conditions: [{ combinator: 'AND', conditions: [] }] }] }] }] };
    expect(problems(deep)[0]).toMatch(/at most 4 levels/);
    const many = { combinator: 'OR', conditions: Array.from({ length: 51 }, () => ({ field: 'user.firstName', operator: 'contains', value: 'a' })) };
    expect(problems(many)[0]).toMatch(/at most 50 conditions/);
    expect(problems({ combinator: 'AND', conditions: [{ field: 'user.firstName', operator: 'contains', value: 'x'.repeat(201) }] })).toHaveLength(1);
  });
});

describe('registration data — sort, select, values', () => {
  it('sorts by chosen fields (nulls last, through relations), then by id; never by a list or the school claim', () => {
    expect(compileSort([{ field: 'user.phone', dir: 'desc' }], ALL)).toEqual([{ phone: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }]);
    expect(compileSort([{ field: 'user.schoolId', dir: 'asc' }, { field: 'user.divisionId', dir: 'desc' }], ALL))
      .toEqual([{ school: { name: { sort: 'asc', nulls: 'last' } } }, { division: { sortOrder: 'desc' } }, { id: 'asc' }]);
    expect(compileSort([{ field: 'coachApplication.yearsOfExperience', dir: 'asc' }], ALL)).toEqual([{ mentorRequest: { yearsOfExperience: { sort: 'asc', nulls: 'last' } } }, { id: 'asc' }]);
    expect(compileSort([], ALL)).toEqual([{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }]);
    expect(() => compileSort([{ field: 'user.olympiadInterests', dir: 'asc' }], ALL)).toThrow(QueryProblem);
    expect(() => compileSort([{ field: 'schoolClaim.claimedName', dir: 'asc' }], ALL)).toThrow(QueryProblem);
  });

  it('selects only what was chosen (and the current school claim alone); reads values back', () => {
    const select = compileSelect([F.first, F.years, F.school, F.claimed]);
    expect(select).toEqual({
      id: true, role: true, updatedAt: true, firstName: true, schoolId: true,
      mentorRequest: { select: { yearsOfExperience: true } }, school: { select: { name: true } },
      schoolAffiliations: { where: { supersededAt: null }, orderBy: { createdAt: 'desc' }, take: 1, select: { claimedName: true } },
    });
    const row = { firstName: 'Ana', mentorRequest: { yearsOfExperience: 4 }, school: { name: 'GS Kigali' }, schoolAffiliations: [{ claimedName: 'G.S. Kigali' }], dateOfBirth: new Date('2010-05-01T00:00:00Z') };
    expect([F.first, F.years, F.school, F.claimed, F.dob, F.phone].map((f) => valueOf(f, row))).toEqual(['Ana', 4, 'GS Kigali', 'G.S. Kigali', '2010-05-01', null]);
    expect(valueOf(F.years, { mentorRequest: null })).toBeNull();
  });

  it('exports: lists joined, yes / no, choices in words', () => {
    expect(exportText(F.subjects, ['MATHEMATICS', 'PHYSICS'])).toBe('MATHEMATICS, PHYSICS');
    expect(exportText(F.edu, 'MASTER')).toBe('Master');
    expect(exportText(F.approved, true)).toBe('Yes');
    expect(exportText(F.phone, null)).toBeNull();
  });

  it('the search box: every word in a name, the e-mail or the username', () => {
    expect(searchWhere('  ')).toEqual({});
    expect((searchWhere('ana uwase') as { AND: unknown[] }).AND).toHaveLength(2);
  });
});

describe('registration data — values for plain fields', () => {
  it('checks each value against its type, with a message that says what to do', () => {
    expect(parsePlainValue(F.phone, ' +250 788-123-456 ')).toEqual({ value: '+250788123456' });
    expect(parsePlainValue(F.phone, '0788123456')).toEqual({ problem: expect.stringMatching(/international format .* \+250788123456/) });
    expect(parsePlainValue(F.phone, '')).toEqual({ value: null });
    expect(parsePlainValue(F.first, '')).toEqual({ problem: 'First name cannot be empty.' });
    expect(parsePlainValue(F.years, '7')).toEqual({ value: 7 });
    expect(parsePlainValue(F.years, 7.5)).toEqual({ problem: expect.stringMatching(/whole number/) });
    expect(parsePlainValue(F.years, 120)).toEqual({ problem: expect.stringMatching(/between 0 and 80/) });
    expect(parsePlainValue(F.edu, 'MASTER')).toEqual({ value: 'MASTER' });
    expect(parsePlainValue(F.edu, 'PHD')).toEqual({ problem: expect.stringMatching(/choose one of Bachelor, Master/) });
    expect(parsePlainValue(F.subjects, ['PHYSICS', 'MATHEMATICS', 'PHYSICS'])).toEqual({ value: ['MATHEMATICS', 'PHYSICS'] });
    expect(parsePlainValue(F.subjects, [])).toEqual({ value: [] });
    expect(parsePlainValue(F.dob, '2010-02-30')).toEqual({ problem: expect.stringMatching(/YYYY-MM-DD/) });
    expect(parsePlainValue(F.approved, 'true')).toEqual({ value: true });
    expect(parsePlainValue(field({ key: 'user.workEmail', type: 'text' }), 'Ana@Example.org')).toEqual({ value: 'ana@example.org' });
    expect(parsePlainValue(field({ key: 'user.notes', type: 'text', maxLength: 5 }), 'abcdef')).toEqual({ problem: expect.stringMatching(/at most 5 characters/) });
  });
});
