/**
 * Registration data (owner 2026-11-23), end to end on a real database:
 *  - access: Super Administrators only (Administrators, coaches, students, teachers 403; anonymous 401);
 *  - the catalogue per category, read from the database: every eligible registration field, no security field;
 *  - queries: every category; every condition of every type on real rows; AND / OR groups; search; sort; pages —
 *    counts checked against the database;
 *  - edits: plain fields (account, coach and teacher application), fields with rules of their own through those rules
 *    (name, e-mail, grade → Olympiad level, school → school claim, interests, home country), what is refused and why,
 *    all problems at once, the version check, the audit entries (personal values masked);
 *  - the coach application ↔ account link: set on approval;
 *  - saved filters (own, shared, names, validation) and column layouts;
 *  - exports: CSV and Excel, the chosen columns in order, the filter respected, formulas neutralised, audited;
 *  - a realistic volume: 50,000 accounts filtered, sorted, paged and exported within time.
 */
import ExcelJS from 'exceljs';

import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Registration data (e2e)', () => {
  let ctx: TestContext;
  let sa: string, sa2: string, admin: string, coach: string, student: string;
  let saId: string, sa2Id: string, coachId: string, teacherId: string, adminMadeCoachId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const B = '/api/v1/admin/registration-data';
  const q = (body: object, query = '') => http().post(`${B}/query${query}`).set(bearer(sa)).send(body);
  const all = (category: string, columns: string[], filter?: object, extra: object = {}) =>
    q({ category, columns, ...(filter && { filter }), ...extra }, '?limit=200').expect(200).then((r) => r.body);
  const AND = (...conditions: object[]) => ({ combinator: 'AND', conditions });
  const OR = (...conditions: object[]) => ({ combinator: 'OR', conditions });
  const c = (field: string, operator: string, value?: unknown, value2?: unknown) => ({ field, operator, value, value2 });

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    const make = (username: string, role: string, extra: Record<string, unknown> = {}) => p().user.create({
      data: { username, firstName: username, lastName: 'Registration', email: `${username}@test.local`, role: role as never, passwordHash: hash, activatedAt: new Date(), ...extra },
    });
    saId = (await make('rd.sa', 'SUPER_ADMIN')).id;
    sa2Id = (await make('rd.sa2', 'SUPER_ADMIN')).id;
    sa = await login(ctx, 'rd.sa');
    sa2 = await login(ctx, 'rd.sa2');
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    student = await login(ctx, 'student.j');

    // A coach who applied (approved through the API: the application is linked to the account).
    const apply = await http().post('/api/v1/mentor-requests').send({
      firstName: 'Claudine', lastName: 'Mukamana', username: 'rd.coach', email: 'rd.coach@example.com', password: 'Mentor123',
      gender: 'FEMALE', country: 'RW', homeProvince: undefined, olympiadInterests: ['PHYSICS'],
    });
    if (apply.status !== 201) {
      // Rwanda needs a home place in some configurations: apply from Kenya instead.
      const again = await http().post('/api/v1/mentor-requests').send({
        firstName: 'Claudine', lastName: 'Mukamana', username: 'rd.coach', email: 'rd.coach@example.com', password: 'Mentor123',
        gender: 'FEMALE', country: 'KE', olympiadInterests: ['PHYSICS'],
      }).expect(201);
      apply.body = again.body;
    }
    await p().mentorRequest.update({ where: { id: apply.body.id }, data: { occupation: 'Lecturer', educationLevel: 'MASTER', yearsOfExperience: 9, affiliation: 'University of Rwanda', phone: '+250788100200' } });
    await http().patch(`/api/v1/mentor-requests/${apply.body.id}/approve`).set(bearer(admin)).expect(200);
    coachId = (await p().user.findUniqueOrThrow({ where: { username: 'rd.coach' } })).id;
    // A coach created by an administrator: no application on record.
    adminMadeCoachId = (await make('rd.coach2', 'MENTOR', { firstName: 'Eric', olympiadInterests: ['MATHEMATICS'] })).id;
    // A teacher with an application.
    teacherId = (await make('rd.teacher', 'TEACHER', { phone: '+250788300400', country: 'RW' })).id;
    await p().teacherApplication.create({
      data: {
        firstName: 'rd.teacher', lastName: 'Registration', username: 'rd.teacher', email: 'rd.teacher@test.local', phone: '+250788300400', country: 'RW',
        olympiadInterests: ['MATHEMATICS'], status: 'APPROVED', schoolProvince: 'Kigali City', schoolDistrict: 'Gasabo', position: 'Head of sciences',
        yearsOfExperience: 12, userId: teacherId,
      },
    });
    // Students with varied registration data.
    await p().user.update({ where: { id: ctx.ids.studentJunior }, data: { firstName: 'Aline', gender: 'FEMALE', phone: '+250788111222', guardianPhone: '+250788999222', olympiadInterests: ['MATHEMATICS', 'PHYSICS'], country: 'RW' } });
    await p().user.update({ where: { id: ctx.ids.studentJunior2 }, data: { firstName: 'Bosco', gender: 'MALE', olympiadInterests: ['COMPUTING'], dateOfBirth: new Date('2012-03-04T00:00:00Z') } });
    await p().user.update({ where: { id: ctx.ids.studentSenior }, data: { firstName: '=SUM(A1)', gender: 'FEMALE', olympiadInterests: [], lastLoginAt: new Date('2026-11-20T21:30:00Z') } });
    await p().studentSchoolAffiliation.create({ data: { studentId: ctx.ids.studentJunior, schoolId: (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } })).schoolId, claimedName: 'GS Kacyiru II', claimedDistrict: 'Gasabo', source: 'REGISTRATION' as never, status: 'PENDING' } });
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  describe('access', () => {
    it('Super Administrators only: Administrators, coaches and students 403; anonymous 401 — on every route', async () => {
      const routes: Array<[string, string, object?]> = [
        ['get', `${B}/fields?category=STUDENTS`], ['post', `${B}/query`, { category: 'STUDENTS', columns: ['user.firstName'] }],
        ['post', `${B}/export?format=csv`, { category: 'STUDENTS', columns: ['user.firstName'] }], ['get', `${B}/users/${ctx.ids.studentJunior}`],
        ['patch', `${B}/users/${ctx.ids.studentJunior}`, { changes: { 'user.phone': '+250788000000' } }], ['get', `${B}/saved-filters`],
        ['get', `${B}/layouts/STUDENTS`],
      ];
      for (const [m, url, body] of routes) {
        for (const token of [admin, coach, student]) expect((await (http() as any)[m](url).set(bearer(token)).send(body)).status, `${m} ${url}`).toBe(403);
        expect((await (http() as any)[m](url).send(body)).status).toBe(401);
      }
      expect((await http().get(`${B}/fields?category=STUDENTS`).set(bearer(sa))).status).toBe(200);
      // Nothing was changed by the refused edit.
      expect((await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } })).phone).toBe('+250788111222');
    });
  });

  describe('the catalogue (read from the database)', () => {
    const keysOf = async (category: string) => (await http().get(`${B}/fields?category=${category}`).set(bearer(sa)).expect(200)).body;

    it('every category offers every registration field it collects, and never a security field', async () => {
      const students = await keysOf('STUDENTS');
      const sk = students.fields.map((f: any) => f.key);
      for (const k of ['user.firstName', 'user.lastName', 'user.username', 'user.email', 'user.phone', 'user.country', 'user.dateOfBirth', 'user.gender',
        'user.guardianPhone', 'user.homeProvince', 'user.homeDistrict', 'user.homeSector', 'user.gradeLevel', 'user.schoolId', 'user.divisionId',
        'user.olympiadInterests', 'user.olympiadInterestOther', 'user.accountStatus', 'user.createdAt', 'school.name', 'school.code', 'school.district',
        'schoolClaim.claimedName', 'schoolClaim.claimedDistrict']) expect(sk, k).toContain(k);
      const coaches = (await keysOf('COACHES')).fields.map((f: any) => f.key);
      for (const k of ['coachApplication.occupation', 'coachApplication.educationLevel', 'coachApplication.affiliation', 'coachApplication.expertise',
        'coachApplication.relevantExperience', 'coachApplication.yearsOfExperience', 'user.olympiadInterests', 'user.phone']) expect(coaches, k).toContain(k);
      for (const k of ['user.gradeLevel', 'user.dateOfBirth', 'coachApplication.email', 'coachApplication.firstName']) expect(coaches, k).not.toContain(k);
      const teachers = (await keysOf('TEACHERS')).fields.map((f: any) => f.key);
      for (const k of ['teacherApplication.position', 'teacherApplication.yearsOfExperience', 'teacherApplication.schoolDistrict', 'teacherApplication.proposedSchoolName']) expect(teachers, k).toContain(k);
      for (const category of ['STUDENTS', 'TEACHERS', 'COACHES', 'HEAD_COACHES', 'ADMINS', 'ALL']) {
        const body = await keysOf(category);
        const text = JSON.stringify(body.fields.map((f: any) => f.key));
        expect(text, category).not.toMatch(/password|hash|token|secret|provider|failedLogin|lockedUntil|avatarFile/i);
        expect(body.defaultColumns.length).toBeGreaterThan(0);
        for (const k of body.defaultColumns) expect(body.fields.map((f: any) => f.key)).toContain(k);
      }
    });

    it('each field says its type, its choices and how it is edited', async () => {
      const f = Object.fromEntries((await keysOf('STUDENTS')).fields.map((x: any) => [x.key, x]));
      expect(f['user.gender']).toMatchObject({ type: 'enum', values: ['FEMALE', 'MALE'], valueLabels: { FEMALE: 'Female' }, editVia: 'account', editable: true });
      expect(f['user.dateOfBirth']).toMatchObject({ type: 'date', personal: true, editVia: 'dateOfBirth', editable: false });
      expect(f['user.divisionId']).toMatchObject({ type: 'enum', reference: 'division', values: ['Junior', 'Middle', 'Senior'], editVia: 'olympiadLevel' });
      expect(f['user.olympiadInterests']).toMatchObject({ type: 'enumList', sortable: false });
      expect(f['user.createdAt']).toMatchObject({ type: 'datetime', editable: false });
      expect(f['user.guardianPhone']).toMatchObject({ type: 'text', personal: true, editVia: 'direct', editable: true });
      expect(f['schoolClaim.claimedName']).toMatchObject({ editable: false, sortable: false });
      expect(f['user.role'].valueLabels.MENTOR).toBe('Coach');
    });

    it('a column in the database but not in the application model stays out until the application knows it', async () => {
      await p().$executeRawUnsafe('ALTER TABLE "User" ADD COLUMN "rdProbeNote" TEXT, ADD COLUMN "rdProbeTokenHash" TEXT');
      try {
        (ctx.app.get(await import('../src/registration-data/field-catalogue.service.js').then((m) => m.FieldCatalogueService))).invalidate();
        const keys = (await keysOf('ALL')).fields.map((x: any) => x.key);
        expect(keys).not.toContain('user.rdProbeNote');
        expect(keys).not.toContain('user.rdProbeTokenHash');
        expect(keys).toContain('user.firstName');
      } finally {
        await p().$executeRawUnsafe('ALTER TABLE "User" DROP COLUMN "rdProbeNote", DROP COLUMN "rdProbeTokenHash"');
      }
    });

    it('an unknown category is refused in plain words', async () => {
      expect((await http().get(`${B}/fields?category=SECRETS`).set(bearer(sa))).status).toBe(400);
    });
  });

  describe('queries', () => {
    const names = (body: any) => body.rows.map((r: any) => r.values['user.firstName']).sort();

    it('every category lists its accounts with the chosen columns, across tables', async () => {
      const students = await all('STUDENTS', ['user.firstName', 'user.schoolId', 'user.divisionId', 'schoolClaim.claimedName', 'school.name']);
      expect(students.meta.total).toBe(await p().user.count({ where: { role: 'STUDENT' } }));
      expect(students.columns.map((x: any) => x.key)).toEqual(['user.firstName', 'user.schoolId', 'user.divisionId', 'schoolClaim.claimedName', 'school.name']);
      const aline = students.rows.find((r: any) => r.id === ctx.ids.studentJunior);
      expect(aline.values).toEqual({ 'user.firstName': 'Aline', 'user.schoolId': 'Test School', 'user.divisionId': 'Junior', 'schoolClaim.claimedName': 'GS Kacyiru II', 'school.name': 'Test School' });
      const coaches = await all('COACHES', ['user.firstName', 'coachApplication.occupation', 'coachApplication.educationLevel', 'coachApplication.yearsOfExperience']);
      expect(coaches.meta.total).toBe(await p().user.count({ where: { role: 'MENTOR' } }));
      expect(coaches.rows.find((r: any) => r.id === coachId).values).toMatchObject({ 'coachApplication.occupation': 'Lecturer', 'coachApplication.educationLevel': 'MASTER', 'coachApplication.yearsOfExperience': 9 });
      expect(coaches.rows.find((r: any) => r.id === adminMadeCoachId).values['coachApplication.occupation']).toBeNull();
      const teachers = await all('TEACHERS', ['user.firstName', 'user.phone', 'teacherApplication.position']);
      expect(teachers.rows.find((r: any) => r.id === teacherId).values).toMatchObject({ 'user.phone': '+250788300400', 'teacherApplication.position': 'Head of sciences' });
      for (const category of ['HEAD_COACHES', 'ADMINS', 'ALL']) {
        const b = await all(category, ['user.firstName', 'user.role']);
        const roles = category === 'HEAD_COACHES' ? ['HEAD_COACH'] : category === 'ADMINS' ? ['ADMIN', 'SUPER_ADMIN'] : undefined;
        expect(b.meta.total, category).toBe(await p().user.count({ where: roles ? { role: { in: roles as never } } : {} }));
      }
    });

    it('text conditions: contains, does not contain, is, is not, starts with, empty, not empty', async () => {
      const S = ['user.firstName'];
      expect(names(await all('STUDENTS', S, AND(c('user.firstName', 'contains', 'LIN'))))).toEqual(['Aline']);
      expect(names(await all('STUDENTS', S, AND(c('user.firstName', 'notContains', 'lin'))))).toEqual(['=SUM(A1)', 'Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.firstName', 'eq', 'bosco'))))).toEqual(['Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.firstName', 'neq', 'bosco'))))).toEqual(['=SUM(A1)', 'Aline']);
      expect(names(await all('STUDENTS', S, AND(c('user.firstName', 'startsWith', 'b'))))).toEqual(['Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.phone', 'isEmpty'))))).toEqual(['=SUM(A1)', 'Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.phone', 'isNotEmpty'))))).toEqual(['Aline']);
      // "Is not" keeps the empty ones (an empty phone is not "+250788111222").
      expect(names(await all('STUDENTS', S, AND(c('user.phone', 'neq', '+250788111222'))))).toEqual(['=SUM(A1)', 'Bosco']);
      // Through a relation: the school's name, and the school as the student entered it.
      expect((await all('STUDENTS', S, AND(c('user.schoolId', 'contains', 'test school')))).meta.total).toBe(3);
      expect(names(await all('STUDENTS', S, AND(c('schoolClaim.claimedName', 'contains', 'kacyiru'))))).toEqual(['Aline']);
      expect(names(await all('STUDENTS', S, AND(c('schoolClaim.claimedName', 'isEmpty'))))).toEqual(['=SUM(A1)', 'Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('schoolClaim.claimedName', 'notContains', 'kacyiru'))))).toEqual(['=SUM(A1)', 'Bosco']);
    });

    it('numbers, dates, yes / no, choices and lists', async () => {
      const C = ['user.firstName'];
      const occ = (b: any) => b.rows.map((r: any) => r.id);
      expect(occ(await all('COACHES', C, AND(c('coachApplication.yearsOfExperience', 'gt', 5))))).toEqual([coachId]);
      expect(occ(await all('COACHES', C, AND(c('coachApplication.yearsOfExperience', 'between', 1, 9))))).toEqual([coachId]);
      expect(occ(await all('COACHES', C, AND(c('coachApplication.yearsOfExperience', 'lt', 9))))).toEqual([]);
      expect(occ(await all('COACHES', C, AND(c('coachApplication.yearsOfExperience', 'eq', 9))))).toEqual([coachId]);
      expect((await all('COACHES', C, AND(c('coachApplication.occupation', 'isEmpty')))).meta.total).toBe(await p().user.count({ where: { role: 'MENTOR' } }) - 1);
      expect(occ(await all('COACHES', C, AND(c('coachApplication.educationLevel', 'in', ['MASTER', 'DOCTORATE']))))).toEqual([coachId]);
      expect(occ(await all('COACHES', C, AND(c('coachApplication.educationLevel', 'notIn', ['MASTER']))))).not.toContain(coachId);
      const S = ['user.firstName'];
      expect(names(await all('STUDENTS', S, AND(c('user.dateOfBirth', 'after', '2011-01-01'))))).toEqual(['Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.dateOfBirth', 'before', '2011-01-01'))))).toEqual(['=SUM(A1)', 'Aline']);
      expect(names(await all('STUDENTS', S, AND(c('user.dateOfBirth', 'on', '2012-03-04'))))).toEqual(['Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.dateOfBirth', 'between', '2012-03-04', '2012-03-04'))))).toEqual(['Bosco']);
      // 21:30 UTC on the 20th is 23:30 on the 20th in Kigali; 22:30 UTC would be the 21st.
      expect(names(await all('STUDENTS', S, AND(c('user.lastLoginAt', 'on', '2026-11-20'))))).toEqual(['=SUM(A1)']);
      expect(names(await all('STUDENTS', S, AND(c('user.lastLoginAt', 'on', '2026-11-21'))))).toEqual([]);
      // student.j (Aline) signed in during the setup.
      expect(names(await all('STUDENTS', S, AND(c('user.lastLoginAt', 'isEmpty'))))).toEqual(['Bosco']);
      expect((await all('STUDENTS', S, AND(c('user.isApproved', 'isTrue')))).meta.total).toBe(3);
      expect((await all('STUDENTS', S, AND(c('user.isApproved', 'isFalse')))).meta.total).toBe(0);
      expect(names(await all('STUDENTS', S, AND(c('user.gender', 'in', ['FEMALE']))))).toEqual(['=SUM(A1)', 'Aline']);
      expect(names(await all('STUDENTS', S, AND(c('user.gradeLevel', 'in', ['S2', 'S3']))))).toEqual(['Aline', 'Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.divisionId', 'in', ['Senior']))))).toEqual(['=SUM(A1)']);
      expect(names(await all('STUDENTS', S, AND(c('user.olympiadInterests', 'hasAny', ['PHYSICS', 'COMPUTING']))))).toEqual(['Aline', 'Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.olympiadInterests', 'hasAll', ['MATHEMATICS', 'PHYSICS']))))).toEqual(['Aline']);
      expect(names(await all('STUDENTS', S, AND(c('user.olympiadInterests', 'hasNone', ['MATHEMATICS']))))).toEqual(['=SUM(A1)', 'Bosco']);
      expect(names(await all('STUDENTS', S, AND(c('user.olympiadInterests', 'isEmpty'))))).toEqual(['=SUM(A1)']);
      expect(names(await all('STUDENTS', S, AND(c('user.olympiadInterests', 'isNotEmpty'))))).toEqual(['Aline', 'Bosco']);
    });

    it('AND / OR groups combine; the search box narrows; problems are refused in plain words', async () => {
      const S = ['user.firstName'];
      const f = AND(c('user.gender', 'in', ['FEMALE']), OR(c('user.phone', 'isNotEmpty'), c('user.firstName', 'startsWith', '=')));
      expect(names(await all('STUDENTS', S, f))).toEqual(['=SUM(A1)', 'Aline']);
      expect(names(await all('STUDENTS', S, OR(c('user.firstName', 'eq', 'aline'), c('user.firstName', 'eq', 'bosco'))))).toEqual(['Aline', 'Bosco']);
      expect(names(await all('STUDENTS', S, undefined, { search: 'bos' }))).toEqual(['Bosco']);
      for (const [body, expected] of [
        [{ category: 'STUDENTS', columns: ['user.passwordHash'] }, /not available for Students/],
        [{ category: 'STUDENTS', columns: ['user.firstName'], filter: AND(c('user.firstName', 'gt', 3)) }, /cannot be filtered with "is greater than"/],
        [{ category: 'STUDENTS', columns: ['user.firstName'], filter: AND(c('user.dateOfBirth', 'on', 'yesterday')) }, /not valid for this field/],
        [{ category: 'STUDENTS', columns: ['user.firstName'], sort: [{ field: 'user.olympiadInterests', dir: 'asc' }] }, /cannot be sorted/],
        [{ category: 'COACHES', columns: ['user.gradeLevel'] }, /not available for Coaches/],
      ] as Array<[object, RegExp]>) {
        const r = await q(body);
        expect(r.status).toBe(400);
        expect(r.body.code).toBe('INVALID_QUERY');
        expect(r.body.message).toMatch(expected);
      }
    });

    it('sorts (through relations too) and pages, with stable totals', async () => {
      const byDob = await all('STUDENTS', ['user.firstName', 'user.dateOfBirth'], undefined, { sort: [{ field: 'user.dateOfBirth', dir: 'desc' }] });
      // Newest date of birth first; the seeded 2010-05-01 next; no value last.
      expect(byDob.rows.map((r: any) => r.values['user.dateOfBirth'])).toEqual(['2012-03-04', '2010-05-01', '2010-05-01']);
      const byLevel = await all('STUDENTS', ['user.firstName', 'user.divisionId'], undefined, { sort: [{ field: 'user.divisionId', dir: 'desc' }] });
      expect(byLevel.rows[0].values['user.divisionId']).toBe('Senior');
      const page1 = (await q({ category: 'ALL', columns: ['user.username'], sort: [{ field: 'user.username', dir: 'asc' }] }, '?page=1&limit=3').expect(200)).body;
      const page2 = (await q({ category: 'ALL', columns: ['user.username'], sort: [{ field: 'user.username', dir: 'asc' }] }, '?page=2&limit=3').expect(200)).body;
      expect(page1.meta).toMatchObject({ page: 1, limit: 3, total: await p().user.count() });
      const u = [...page1.rows, ...page2.rows].map((r: any) => r.values['user.username']);
      expect(u).toEqual([...u].sort());
      expect(new Set(u).size).toBe(6);
    });
  });

  describe('editing a record', () => {
    const record = async (id: string) => (await http().get(`${B}/users/${id}`).set(bearer(sa)).expect(200)).body;
    const valueIn = (r: any, key: string) => r.fields.find((f: any) => f.key === key)?.value;
    const patch = (id: string, changes: object, extra: object = {}) => http().patch(`${B}/users/${id}`).set(bearer(sa)).send({ changes, ...extra });

    it("a record lists every field of the account's category, its value and how it is changed", async () => {
      const r = await record(coachId);
      expect(r).toMatchObject({ category: 'COACHES', role: 'MENTOR', hasCoachApplication: true });
      expect(valueIn(r, 'coachApplication.occupation')).toBe('Lecturer');
      expect(r.fields.find((f: any) => f.key === 'user.accountStatus')).toMatchObject({ editable: false, note: expect.stringMatching(/Change account status/) });
      const made = await record(adminMadeCoachId);
      expect(made.hasCoachApplication).toBe(false);
      expect(made.fields.find((f: any) => f.key === 'coachApplication.occupation')).toMatchObject({ editable: false, note: expect.stringMatching(/no coach application on record/) });
      expect(JSON.stringify(r)).not.toMatch(/passwordHash|\$2[aby]\$/);
    });

    it('plain fields of the account and of the application: one transaction, audited with old and new values (personal values masked)', async () => {
      const before = await record(coachId);
      const r = (await patch(coachId, {
        'coachApplication.occupation': 'Senior lecturer', 'coachApplication.yearsOfExperience': '11', 'coachApplication.educationLevel': 'DOCTORATE',
        'user.phone': '+250 788 555 666',
      }, { version: before.version }).expect(200)).body;
      expect(valueIn(r, 'coachApplication.occupation')).toBe('Senior lecturer');
      expect(valueIn(r, 'coachApplication.yearsOfExperience')).toBe(11);
      expect(valueIn(r, 'user.phone')).toBe('+250788555666');
      const entry = await p().auditLog.findFirstOrThrow({ where: { action: 'REGISTRATION_DATA_UPDATED', entityId: coachId }, orderBy: { createdAt: 'desc' } });
      expect(entry.actorId).toBe(saId);
      const changes = (entry.metadata as any).changes;
      expect(changes).toEqual(expect.arrayContaining([
        { field: 'coachApplication.occupation', label: 'Occupation', from: 'Lecturer', to: 'Senior lecturer' },
        { field: 'coachApplication.yearsOfExperience', label: 'Years of experience', from: 9, to: 11 },
        { field: 'user.phone', label: 'Phone number', changed: true },
      ]));
      expect(JSON.stringify(entry.metadata)).not.toContain('555666');
    });

    it('fields with rules go through those rules: name, e-mail, grade → Olympiad level, school, interests (any role), home country', async () => {
      const school2 = await p().school.create({ data: { name: 'GS Remera', location: 'Kigali' } });
      const r = (await patch(ctx.ids.studentJunior2, {
        'user.firstName': 'Jean Bosco', 'user.email': 'BOSCO.NEW@example.org', 'user.gradeLevel': 'S5', 'user.schoolId': school2.id,
        'user.olympiadInterests': ['PHYSICS', 'MATHEMATICS'], 'user.guardianPhone': '+250788777888', 'user.country': 'KE',
      }).expect(200)).body;
      expect(valueIn(r, 'user.firstName')).toBe('Jean Bosco');
      expect(valueIn(r, 'user.email')).toBe('bosco.new@example.org');
      expect(valueIn(r, 'user.gradeLevel')).toBe('S5');
      expect(valueIn(r, 'user.divisionId')).toBe('Senior');                       // the grade's Olympiad level (rules)
      expect(valueIn(r, 'user.schoolId')).toBe('GS Remera');
      expect(valueIn(r, 'user.olympiadInterests')).toEqual(['MATHEMATICS', 'PHYSICS']);
      expect(valueIn(r, 'user.country')).toBe('KE');
      // The school claim moved with the school (rules); the enrolment follows the placement.
      const claim = await p().studentSchoolAffiliation.findFirst({ where: { studentId: ctx.ids.studentJunior2, supersededAt: null } });
      expect(claim?.schoolId).toBe(school2.id);
      expect(await p().auditLog.count({ where: { entityId: ctx.ids.studentJunior2, action: { in: ['UPDATE_USER', 'USER_UPDATED'] } } })).toBeGreaterThan(0);
      const mine = await p().auditLog.findFirstOrThrow({ where: { action: 'REGISTRATION_DATA_UPDATED', entityId: ctx.ids.studentJunior2 } });
      expect((mine.metadata as any).throughAccountRules).toEqual(expect.arrayContaining(['user.firstName', 'user.email', 'user.gradeLevel', 'user.schoolId']));
    });

    it('refused, with every problem at once and what to do: own-action fields, system fields, unknown fields, bad values', async () => {
      const r = await patch(ctx.ids.studentJunior, {
        'user.accountStatus': 'SUSPENDED', 'user.dateOfBirth': '2011-01-01', 'user.createdAt': '2020-01-01', 'user.passwordHash': 'x',
        'user.phone': '0788', 'user.gender': 'OTHER', 'coachApplication.occupation': 'x',
      });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_VALUES');
      const msgs = r.body.details.problems.map((x: any) => x.message).join(' | ');
      expect(msgs).toMatch(/Account status cannot be changed here\. Use "Change account status"/);
      expect(msgs).toMatch(/Date of birth cannot be changed here\. Use "Correct date of birth"/);
      expect(msgs).toMatch(/Registered on cannot be changed here\. It is kept by the system/);
      expect(msgs).toMatch(/"user.passwordHash" is not part of/);
      expect(msgs).toMatch(/Phone number: use the international format/);
      expect(msgs).toMatch(/Gender/);
      expect(msgs).toMatch(/"coachApplication.occupation" is not part of/);
      expect(r.body.message).toMatch(/more problems — check the form/);
      const after = await p().user.findUniqueOrThrow({ where: { id: ctx.ids.studentJunior } });
      expect(after).toMatchObject({ phone: '+250788111222', accountStatus: 'ACTIVE' });
      expect((await patch(ctx.ids.studentJunior, {})).body.code).toBe('NO_CHANGES');
      expect((await patch(adminMadeCoachId, { 'coachApplication.occupation': 'Engineer' })).status).toBe(409);
      expect((await patch(ctx.ids.studentJunior, { 'user.email': 'rd.coach@example.com' })).status).toBe(409);   // taken
    });

    it('a stale version is refused (someone changed the record meanwhile); nothing is written', async () => {
      const r = await record(teacherId);
      await patch(teacherId, { 'teacherApplication.position': 'Deputy head' }, { version: r.version }).expect(200);
      const stale = await patch(teacherId, { 'user.firstName': 'Late' }, { version: '2000-01-01T00:00:00.000Z' });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('RECORD_CHANGED');
      expect((await p().user.findUniqueOrThrow({ where: { id: teacherId } })).firstName).toBe('rd.teacher');
      expect((await p().teacherApplication.findUniqueOrThrow({ where: { userId: teacherId } })).position).toBe('Deputy head');
    });

    it('a role change to Administrator needs your own password (the account rules)', async () => {
      const refused = await patch(adminMadeCoachId, { 'user.role': 'ADMIN' });
      expect(refused.status).toBe(403);
      expect((await p().user.findUniqueOrThrow({ where: { id: adminMadeCoachId } })).role).toBe('MENTOR');
    });

    it('the coach application is linked to the account its approval created', async () => {
      expect((await p().mentorRequest.findFirstOrThrow({ where: { username: 'rd.coach' } })).userId).toBe(coachId);
    });
  });

  describe('saved filters and column layouts', () => {
    const girls = { name: 'Girls in Physics', category: 'STUDENTS', columns: ['user.firstName', 'user.gender', 'user.olympiadInterests'],
      filter: AND(c('user.gender', 'in', ['FEMALE']), c('user.olympiadInterests', 'hasAny', ['PHYSICS'])), sort: [{ field: 'user.lastName', dir: 'asc' }] };

    it('save, list, reopen, change, delete; names unique per person; validated', async () => {
      const saved = (await http().post(`${B}/saved-filters`).set(bearer(sa)).send(girls).expect(201)).body;
      expect(saved).toMatchObject({ name: 'Girls in Physics', mine: true, shared: false, owner: { id: saId } });
      expect((await http().post(`${B}/saved-filters`).set(bearer(sa)).send(girls)).body.code).toBe('NAME_TAKEN');
      expect((await http().get(`${B}/saved-filters?category=STUDENTS`).set(bearer(sa)).expect(200)).body.map((x: any) => x.name)).toEqual(['Girls in Physics']);
      expect((await http().get(`${B}/saved-filters`).set(bearer(sa2)).expect(200)).body).toEqual([]);         // private
      // Applied: the saved definition runs as it is.
      const run = await all(saved.category, saved.columns, saved.filter);
      expect(run.rows.map((r: any) => r.id)).toEqual([ctx.ids.studentJunior]);
      const changed = (await http().put(`${B}/saved-filters/${saved.id}`).set(bearer(sa)).send({ ...girls, name: 'Girls (Physics)', shared: true }).expect(200)).body;
      expect(changed).toMatchObject({ name: 'Girls (Physics)', shared: true });
      // Shared: another Super Administrator uses it, cannot change or delete it.
      expect((await http().get(`${B}/saved-filters`).set(bearer(sa2)).expect(200)).body[0]).toMatchObject({ name: 'Girls (Physics)', mine: false });
      const other = await http().put(`${B}/saved-filters/${saved.id}`).set(bearer(sa2)).send(girls);
      expect(other.status).toBe(403);
      expect(other.body.message).toMatch(/Save a copy under a new name/);
      expect((await http().delete(`${B}/saved-filters/${saved.id}`).set(bearer(sa2))).status).toBe(403);
      for (const bad of [{ ...girls, name: 'x2', columns: ['user.passwordHash'] }, { ...girls, name: 'x3', filter: AND(c('user.firstName', 'between', 1, 2)) }, { ...girls, name: 'x4', category: 'NOPE' }]) {
        expect((await http().post(`${B}/saved-filters`).set(bearer(sa)).send(bad)).status).toBe(400);
      }
      await http().delete(`${B}/saved-filters/${saved.id}`).set(bearer(sa)).expect(200);
      expect((await http().get(`${B}/saved-filters`).set(bearer(sa)).expect(200)).body).toEqual([]);
    });

    it('columns per category and person: default, saved, reset; validated', async () => {
      const def = (await http().get(`${B}/layouts/COACHES`).set(bearer(sa)).expect(200)).body;
      expect(def.source).toBe('DEFAULT');
      expect(def.columns).toContain('coachApplication.occupation');
      const saved = (await http().put(`${B}/layouts/COACHES`).set(bearer(sa)).send({ columns: ['coachApplication.yearsOfExperience', 'user.lastName'] }).expect(200)).body;
      expect(saved).toMatchObject({ source: 'USER', columns: ['coachApplication.yearsOfExperience', 'user.lastName'] });
      expect((await http().get(`${B}/layouts/COACHES`).set(bearer(sa2)).expect(200)).body.source).toBe('DEFAULT');   // per person
      expect((await http().get(`${B}/layouts/STUDENTS`).set(bearer(sa)).expect(200)).body.source).toBe('DEFAULT');   // per category
      expect((await http().put(`${B}/layouts/COACHES`).set(bearer(sa)).send({ columns: ['user.gradeLevel'] })).status).toBe(400);
      expect((await http().put(`${B}/layouts/COACHES`).set(bearer(sa)).send({ columns: ['user.lastName', 'user.lastName'] })).status).toBe(400);
      expect((await http().delete(`${B}/layouts/COACHES`).set(bearer(sa)).expect(200)).body.source).toBe('DEFAULT');
    });
  });

  describe('exports', () => {
    const exp = (format: string, body: object) => http().post(`${B}/export?format=${format}`).set(bearer(sa)).send(body)
      .buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (d: Buffer) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks))); });

    it('CSV: the chosen columns in order, the filter respected, formulas neutralised, audited', async () => {
      const body = { category: 'STUDENTS', columns: ['user.lastName', 'user.firstName', 'user.gender', 'user.olympiadInterests', 'user.guardianPhone'],
        filter: AND(c('user.gender', 'in', ['FEMALE'])), sort: [{ field: 'user.firstName', dir: 'asc' }] };
      const r = await exp('csv', body).expect(200);
      expect(r.headers['content-type']).toMatch(/text\/csv/);
      expect(r.headers['content-disposition']).toMatch(/registration-data-students-\d{4}-\d{2}-\d{2}\.csv/);
      const lines = r.body.toString('utf8').replace(/^﻿/, '').trim().split(/\r\n/);
      expect(lines[0]).toBe('Last name,First name,Gender,Olympiad subjects,Parent or guardian phone');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe("Test,'=SUM(A1),Female,,");
      // CSV: a text starting with = + - @ gets an apostrophe (spreadsheet formula protection, reports/csv.ts) — phones too.
      expect(lines[2]).toBe(`Test,Aline,Female,"Mathematics, Physics",'+250788999222`);
      const audit = await p().auditLog.findFirstOrThrow({ where: { action: 'REGISTRATION_DATA_EXPORTED' }, orderBy: { createdAt: 'desc' } });
      expect(audit.metadata).toMatchObject({ category: 'STUDENTS', format: 'csv', rows: 2, personalColumns: ['user.guardianPhone'], filtered: true });
    });

    it('Excel: the same rows and columns', async () => {
      const r = await exp('xlsx', { category: 'COACHES', columns: ['user.username', 'coachApplication.occupation', 'coachApplication.yearsOfExperience'], sort: [{ field: 'user.username', dir: 'asc' }] }).expect(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body);
      const ws = wb.worksheets[0];
      expect(ws.getRow(1).values).toEqual([undefined, 'Username', 'Occupation', 'Years of experience']);
      const rows = ws.getSheetValues().slice(2).map((v: any) => v.slice(1));
      expect(rows).toHaveLength(await p().user.count({ where: { role: 'MENTOR' } }));
      expect(rows.find((x: any[]) => x[0] === 'rd.coach')).toEqual(['rd.coach', 'Senior lecturer', 11]);
    });

    it('refuses an invalid export before sending anything', async () => {
      const r = await http().post(`${B}/export?format=csv`).set(bearer(sa)).send({ category: 'STUDENTS', columns: ['user.passwordHash'] });
      expect(r.status).toBe(400);
      expect((await http().post(`${B}/export?format=pdf`).set(bearer(sa)).send({ category: 'STUDENTS', columns: ['user.firstName'] })).status).toBe(400);
    });
  });

  describe('a realistic volume (50,000 accounts)', () => {
    beforeAll(async () => {
      const hash = 'x';
      const grades = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const;
      for (let b = 0; b < 10; b += 1) {
        await p().user.createMany({
          data: Array.from({ length: 5_000 }, (_, i) => {
            const n = b * 5_000 + i;
            return {
              username: `bulk${n}`, email: `bulk${n}@volume.test`, firstName: `Student${n}`, lastName: `Volume${n % 997}`, passwordHash: hash,
              role: 'STUDENT' as const, gradeLevel: grades[n % 6], gender: (n % 2 ? 'FEMALE' : 'MALE') as never, schoolId: null,
              olympiadInterests: (n % 3 === 0 ? ['MATHEMATICS'] : n % 3 === 1 ? ['PHYSICS', 'COMPUTING'] : []) as never,
              dateOfBirth: new Date(Date.UTC(2008 + (n % 6), n % 12, 1 + (n % 28))), phone: n % 4 === 0 ? `+2507880${String(n).padStart(5, '0')}` : null,
            };
          }),
        });
      }
    }, 180_000);

    it('filters, sorts and pages 50,000 accounts in the database, quickly', async () => {
      const filter = AND(c('user.gender', 'in', ['FEMALE']), OR(c('user.olympiadInterests', 'hasAny', ['PHYSICS']), c('user.phone', 'isNotEmpty')), c('user.dateOfBirth', 'after', '2008-06-01'));
      const t0 = Date.now();
      const r = (await q({ category: 'STUDENTS', columns: ['user.firstName', 'user.lastName', 'user.dateOfBirth', 'user.olympiadInterests', 'user.schoolId'], filter, sort: [{ field: 'user.lastName', dir: 'desc' }] }, '?page=40&limit=100').expect(200)).body;
      const ms = Date.now() - t0;
      const expected = await p().user.count({ where: { role: 'STUDENT', gender: 'FEMALE', dateOfBirth: { gte: new Date('2008-06-02T00:00:00Z') },
        OR: [{ olympiadInterests: { hasSome: ['PHYSICS'] } }, { AND: [{ phone: { not: null } }, { NOT: { phone: '' } }] }] } });
      expect(r.meta.total).toBe(expected);
      expect(expected, JSON.stringify(r.meta)).toBeGreaterThan(4_000);
      expect(r.rows).toHaveLength(100);
      const last = r.rows.map((x: any) => x.values['user.lastName']);
      expect(last).toEqual([...last].sort().reverse());
      expect(ms).toBeLessThan(5_000);
    });

    it('exports every matching row, streamed, within time', async () => {
      const t0 = Date.now();
      const r = await http().post(`${B}/export?format=csv`).set(bearer(sa))
        .send({ category: 'STUDENTS', columns: ['user.username', 'user.gradeLevel', 'user.dateOfBirth'], filter: AND(c('user.gradeLevel', 'in', ['S1', 'S2', 'S3'])) })
        .buffer(true).parse((res, cb) => { let s = ''; res.on('data', (d: Buffer) => { s += d.toString('utf8'); }); res.on('end', () => cb(null, s)); })
        .expect(200);
      const ms = Date.now() - t0;
      const lines = (r.body as string).trim().split(/\r\n/);
      expect(lines.length - 1).toBe(await p().user.count({ where: { role: 'STUDENT', gradeLevel: { in: ['S1', 'S2', 'S3'] } } }));
      expect(new Set(lines.slice(1).map((l) => l.split(',')[0])).size).toBe(lines.length - 1);   // no row twice
      expect(ms).toBeLessThan(60_000);
    }, 120_000);
  });
});
