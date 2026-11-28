/**
 * Custom reports, table layouts and Users-list sorting (owner 2026-11-22), end to end.
 *  - reports: the catalogue has no sensitive field; builders preview, save, run, export (CSV, Excel); definitions are
 *    validated; rows stay within the viewer's scope; grants to users and roles, each level independent (view only,
 *    download, edit, all); students never; enforced by the API (404 without access, 403 for a missing level);
 *    deleting keeps history; everything audited;
 *  - layouts: own layout per table (wins), back to the organization default; the organization default by
 *    Administrators only; validated; a new column is never lost;
 *  - the Users list sorts by name, last login (never-signed-in last) and registration date; filters still apply.
 */
import ExcelJS from 'exceljs';

import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Custom reports, table layouts and sorting (e2e)', () => {
  let ctx: TestContext;
  let admin: string, coach: string, student: string, teacher: string, hc: string;
  let teacherId: string, hcId: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const status = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const R = '/api/v1/reports';
  const studentsByGrade = { name: 'Students by grade', description: 'For the coordinators', source: 'STUDENTS', columns: ['fullName', 'grade', 'olympiadLevel', 'school'],
    filters: [{ field: 'accountStatus', op: 'eq', value: 'ACTIVE' }], sort: [{ field: 'grade', dir: 'asc' }] };
  /** The definition alone (a preview takes no name or description: unknown fields are refused). */
  const { name: _name, description: _description, ...definition } = studentsByGrade;

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    student = await login(ctx, 'student.j');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    teacherId = (await p().user.create({ data: { username: 'cr.teacher', firstName: 'T', lastName: 'Reports', email: 'cr.teacher@test.local', role: 'TEACHER', passwordHash: hash, activatedAt: new Date() } })).id;
    hcId = (await p().user.create({ data: { username: 'cr.hc', firstName: 'H', lastName: 'Reports', email: 'cr.hc@test.local', role: 'HEAD_COACH', passwordHash: hash, activatedAt: new Date() } })).id;
    teacher = await login(ctx, 'cr.teacher');
    hc = await login(ctx, 'cr.hc');
    await p().user.update({ where: { id: ctx.ids.studentJunior }, data: { lastLoginAt: new Date('2026-11-20T08:00:00Z'), phone: '+250788999111', guardianPhone: '+250788999222' } });
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  describe('reports', () => {
    let reportId: string;

    it('the catalogue: an Administrator sees the people and Administrators\' sources (no banking), no personal field; builders only', async () => {
      const cat = (await http().get(`${R}/sources`).set(bearer(admin)).expect(200)).body;
      expect(cat.sources.map((s: any) => s.key).slice(0, 4)).toEqual(['STUDENTS', 'COACHES', 'TEACHERS', 'USERS']);
      expect(cat.sources.map((s: any) => s.key)).toEqual(expect.arrayContaining(['SCHOOLS', 'TEST_RESULTS', 'ASSIGNMENT_GRADES', 'ENROLMENTS', 'TEACHER_APPLICATIONS', 'COACH_APPLICATIONS', 'SUBSCRIBERS']));
      expect(cat.sources.map((s: any) => s.key)).not.toContain('BANKING');
      const keys = cat.sources.flatMap((s: any) => s.fields.map((f: any) => f.key));
      for (const k of ['phone', 'guardianPhone', 'dateOfBirth', 'homeLocation', 'homeSector', 'passwordHash', 'personalAccount', 'schoolAccount']) expect(keys).not.toContain(k);
      expect(cat.sources.flatMap((s: any) => s.fields).every((f: any) => f.protected === false)).toBe(true);
      for (const token of [coach, student, teacher, hc]) expect((await http().get(`${R}/sources`).set(bearer(token))).status).toBe(403);
    });

    it('preview, then save: live rows, the chosen columns in order; invalid definitions refused', async () => {
      const pv = (await http().post(`${R}/preview`).set(bearer(admin)).send(definition).expect(201)).body;
      expect(pv.columns.map((c: any) => c.key)).toEqual(['fullName', 'grade', 'olympiadLevel', 'school']);
      expect(pv.meta.total).toBe(await p().user.count({ where: { role: 'STUDENT', accountStatus: 'ACTIVE' } }));
      const grades = pv.rows.map((r: any[]) => r[1]);
      expect(grades).toEqual([...grades].sort());
      expect(JSON.stringify(pv)).not.toContain('788999');
      for (const bad of [
        { ...definition, source: 'SECRETS' }, { ...definition, columns: ['fullName', 'phone'] }, { ...definition, columns: [] },
        { ...definition, filters: [{ field: 'coachCourses', op: 'eq', value: 'x' }] }, { ...definition, sort: [{ field: 'subjects', dir: 'asc' }] },
        { ...definition, columns: ['grade', 'grade'] }, studentsByGrade,
      ]) expect((await status(http().post(`${R}/preview`).set(bearer(admin)).send(bad)))[0]).toBe(400);
      const saved = (await http().post(R).set(bearer(admin)).send(studentsByGrade).expect(201)).body;
      expect(saved).toMatchObject({ name: 'Students by grade', source: 'STUDENTS', myAccess: { view: true, download: true, edit: true, manage: true } });
      reportId = saved.id;
      expect(await p().auditLog.count({ where: { action: 'REPORT_CREATED', entityId: reportId } })).toBe(1);
    });

    it('ready-made examples: never logged in; by Olympiad subject; recently registered; coaches with what they teach', async () => {
      const run = async (body: object) => (await http().post(`${R}/preview`).set(bearer(admin)).send(body).expect(201)).body;
      const never = await run({ source: 'USERS', columns: ['fullName', 'role', 'lastLoginAt'], filters: [{ field: 'neverLoggedIn', op: 'eq', value: true }] });
      expect(never.meta.total).toBe(await p().user.count({ where: { lastLoginAt: null } }));
      const maths = await run({ source: 'STUDENTS', columns: ['fullName', 'subjects'], filters: [{ field: 'subjects', op: 'in', value: ['MATHEMATICS'] }] });
      expect(maths.meta.total).toBe(await p().user.count({ where: { role: 'STUDENT', olympiadInterests: { has: 'MATHEMATICS' } } }));
      const recent = await run({ source: 'USERS', columns: ['fullName', 'registeredAt'], filters: [{ field: 'registeredAt', op: 'gte', value: '2000-01-01' }], sort: [{ field: 'registeredAt', dir: 'desc' }] });
      expect(recent.meta.total).toBe(await p().user.count());
      const coaches = await run({ source: 'COACHES', columns: ['fullName', 'coachCourses', 'coachAssignments'] });
      expect(coaches.rows.find((r: any[]) => r[0] === 'mentor.j Test')[1]).toContain('(Junior)');
    });

    it('sharing: a user with view only runs it but cannot download or edit; a role with download; edit lets a coach change it; students never', async () => {
      const grants = (await http().put(`${R}/${reportId}/grants`).set(bearer(admin)).send({ grants: [
        { userId: teacherId, canView: true, canDownload: false, canEdit: false },
        { role: 'HEAD_COACH', canView: true, canDownload: true, canEdit: false },
        { userId: ctx.ids.mentorJunior, canView: true, canDownload: true, canEdit: true },
      ] }).expect(200)).body;
      expect(grants.grants).toHaveLength(3);
      expect((await p().auditLog.findFirstOrThrow({ where: { action: 'REPORT_GRANTS_SET', entityId: reportId } })).metadata).toMatchObject({ name: 'Students by grade' });
      // Students never: refused, nothing changed.
      expect(await status(http().put(`${R}/${reportId}/grants`).set(bearer(admin)).send({ grants: [{ role: 'STUDENT', canView: true, canDownload: false, canEdit: false }] }))).toEqual([400, 'GRANTEE_NOT_ALLOWED']);
      expect(await status(http().put(`${R}/${reportId}/grants`).set(bearer(admin)).send({ grants: [{ userId: ctx.ids.studentJunior, canView: true, canDownload: false, canEdit: false }] }))).toEqual([400, 'GRANTEE_NOT_ALLOWED']);
      expect(await p().customReportGrant.count({ where: { reportId } })).toBe(3);

      // The teacher (view only): listed, runs it (their scope: no school → no rows), no download, no edit, no grants.
      expect((await http().get(R).set(bearer(teacher)).expect(200)).body.map((r: any) => [r.id, r.myAccess])).toEqual([[reportId, { view: true, download: false, edit: false, manage: false }]]);
      expect((await http().get(`${R}/${reportId}/run`).set(bearer(teacher)).expect(200)).body.meta.total).toBe(0);
      expect(await status(http().get(`${R}/${reportId}/export`).query({ format: 'csv' }).set(bearer(teacher)))).toEqual([403, 'REPORT_ACCESS_DENIED']);
      expect(await status(http().put(`${R}/${reportId}`).set(bearer(teacher)).send(studentsByGrade))).toEqual([403, 'REPORT_ACCESS_DENIED']);
      expect(await status(http().get(`${R}/${reportId}/grants`).set(bearer(teacher)))).toEqual([403, 'REPORT_ACCESS_DENIED']);
      // A Head Coach through the role: download allowed (their scope: their programmes' members — none here).
      const csv = await http().get(`${R}/${reportId}/export`).query({ format: 'csv' }).set(bearer(hc)).expect(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.text.replace(/^﻿/, '').split('\r\n')[0]).toBe('Full name,Grade,Olympiad level,School');
      // The coach with edit: changes it (audited) and previews; still cannot manage access or delete.
      await http().put(`${R}/${reportId}`).set(bearer(coach)).send({ ...studentsByGrade, name: 'Students by grade (coach)' }).expect(200);
      await http().post(`${R}/${reportId}/preview`).set(bearer(coach)).send(definition).expect(201);
      expect(await status(http().delete(`${R}/${reportId}`).set(bearer(coach)))).toEqual([403, 'REPORT_ACCESS_DENIED']);
      expect(await p().auditLog.count({ where: { action: 'REPORT_UPDATED', entityId: reportId, actorId: ctx.ids.mentorJunior } })).toBe(1);
      // The coach's rows: exactly the active students of their programmes or of the divisions they teach.
      const coachRun = (await http().get(`${R}/${reportId}/run`).query({ limit: 200 }).set(bearer(coach)).expect(200)).body;
      const programmes = (await p().programmeMembership.findMany({ where: { userId: ctx.ids.mentorJunior, isActive: true } })).map((m) => m.disciplineId);
      const taught = (await p().mentorAssignment.findMany({ where: { mentorId: ctx.ids.mentorJunior, isActive: true } })).map((m) => m.divisionId);
      expect(coachRun.meta.total).toBe(await p().user.count({ where: { role: 'STUDENT', accountStatus: 'ACTIVE', OR: [
        { programmeMemberships: { some: { isActive: true, disciplineId: { in: programmes } } } }, { divisionId: { in: taught } },
      ] } }));
      // A student outside both is never in it.
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
      const outside = await p().user.create({ data: { username: 'cr.outside', firstName: 'Out', lastName: 'Side', email: 'cr.outside@test.local', role: 'STUDENT', passwordHash: hash, activatedAt: new Date(), gradeLevel: 'S5', divisionId: ctx.ids.senior } });
      const again = (await http().get(`${R}/${reportId}/run`).query({ limit: 200 }).set(bearer(coach)).expect(200)).body;
      expect(again.meta.total).toBe(coachRun.meta.total);
      expect((await http().get(`${R}/${reportId}/run`).query({ limit: 200 }).set(bearer(admin)).expect(200)).body.rows.some((r: any[]) => r[0] === 'Out Side')).toBe(true);
      await p().user.delete({ where: { id: outside.id } });
      // Students: nothing at all (404, as an unknown report).
      for (const path of [`${R}/${reportId}`, `${R}/${reportId}/run`]) expect((await http().get(path).set(bearer(student))).status).toBe(404);
      expect((await http().get(R).set(bearer(student)).expect(200)).body).toEqual([]);
    });

    it('downloads: CSV and Excel with the same rows (audited); a revoked grant applies at once; delete keeps history', async () => {
      const csv = await http().get(`${R}/${reportId}/export`).query({ format: 'csv' }).set(bearer(admin)).expect(200);
      const lines = csv.text.replace(/^﻿/, '').trim().split('\r\n');
      const xlsx = await http().get(`${R}/${reportId}/export`).query({ format: 'xlsx' }).set(bearer(admin)).buffer(true)
        .parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.body as never);
      // ROF formatting (owner 2026-11-28): six title lines (logo, name, title, data, filters, generated by/when), then the
      // header on row 7 and the same rows as the CSV.
      expect(wb.worksheets[0].rowCount).toBe(6 + lines.length);
      expect((wb.worksheets[0].getRow(7).values as unknown[]).slice(1).join(',')).toBe(lines[0].replace(/"/g, ''));
      expect(await p().auditLog.count({ where: { action: 'REPORT_EXPORTED', entityId: reportId } })).toBeGreaterThanOrEqual(3);
      // Revoke the teacher: their next call is refused.
      await http().put(`${R}/${reportId}/grants`).set(bearer(admin)).send({ grants: [{ role: 'HEAD_COACH', canView: true, canDownload: true, canEdit: false }] }).expect(200);
      expect((await http().get(`${R}/${reportId}/run`).set(bearer(teacher))).status).toBe(404);
      await http().delete(`${R}/${reportId}`).set(bearer(admin)).expect(200);
      expect((await http().get(`${R}/${reportId}`).set(bearer(admin))).status).toBe(404);
      expect(await p().customReport.count({ where: { id: reportId, deletedAt: { not: null } } })).toBe(1);
    });
  });

  describe('table layouts', () => {
    const T = (table: string, org = false) => `/api/v1/${org ? 'admin' : 'me'}/table-layouts/${table}`;
    it('the built-in default has no username; own layout wins; back to the organization default', async () => {
      const def = (await http().get(T('users.students')).set(bearer(admin)).expect(200)).body;
      expect(def).toMatchObject({ source: 'DEFAULT' });
      expect(def.columns.find((c: any) => c.key === 'username')).toEqual({ key: 'username', visible: false });
      expect(def.columns.find((c: any) => c.key === 'lastLoginAt')).toEqual({ key: 'lastLoginAt', visible: true });
      const mine = [{ key: 'lastLoginAt', visible: true }, { key: 'name', visible: true }, { key: 'email', visible: false }];
      const saved = (await http().put(T('users.students')).set(bearer(admin)).send({ columns: mine }).expect(200)).body;
      expect(saved.source).toBe('USER');
      expect(saved.columns.slice(0, 3)).toEqual(mine);
      expect(saved.columns.length).toBe(def.columns.length);   // the other columns kept, at their defaults
      // The organization default (Administrators): another admin's view follows it until they save their own.
      await http().put(T('users.students', true)).set(bearer(admin)).send({ columns: [{ key: 'name', visible: true }, { key: 'grade', visible: true }] }).expect(200);
      expect(await p().auditLog.count({ where: { action: 'TABLE_LAYOUT_DEFAULT_SET' } })).toBe(1);
      const reset = (await http().delete(T('users.students')).set(bearer(admin)).expect(200)).body;
      expect(reset.source).toBe('ORG');
      expect(reset.columns.slice(0, 2)).toEqual([{ key: 'name', visible: true }, { key: 'grade', visible: true }]);
      expect((await http().delete(T('users.students', true)).set(bearer(admin)).expect(200)).body.source).toBe('DEFAULT');
    });

    it('validated: unknown table or column, duplicates, nothing visible; organization default by Administrators only', async () => {
      await http().get(T('users.secret')).set(bearer(admin)).expect(404);
      for (const columns of [[{ key: 'phone', visible: true }], [{ key: 'name', visible: true }, { key: 'name', visible: false }], [{ key: 'name', visible: false }]]) {
        expect(await status(http().put(T('users.students')).set(bearer(admin)).send({ columns }))).toEqual([400, 'INVALID_LAYOUT']);
      }
      for (const token of [coach, student, teacher]) expect((await http().put(T('users.students', true)).set(bearer(token)).send({ columns: [{ key: 'name', visible: true }] })).status).toBe(403);
      for (const token of [student, teacher]) expect((await http().get(T('users.students')).set(bearer(token))).status).toBe(403);
    });
  });

  describe('Users list sorting', () => {
    it('by last login (never-signed-in last), by name, by registration date; filters still apply', async () => {
      const list = async (q: object) => (await http().get('/api/v1/admin/users').query({ limit: 100, ...q }).set(bearer(admin)).expect(200)).body.data;
      const byLogin = await list({ sort: 'lastLoginAt', order: 'desc' });
      const logins = byLogin.map((u: any) => u.lastLoginAt);
      const firstNull = logins.indexOf(null);
      expect(logins.slice(firstNull === -1 ? logins.length : firstNull).every((x: unknown) => x === null)).toBe(true);
      const byName = await list({ sort: 'name', order: 'asc', role: 'STUDENT' });
      expect(byName.every((u: any) => u.role === 'STUDENT')).toBe(true);
      const names = byName.map((u: any) => u.lastName);
      expect(names).toEqual([...names].sort((a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' }) || 0));
      const byDate = await list({});
      const dates = byDate.map((u: any) => new Date(u.createdAt).getTime());
      expect(dates).toEqual([...dates].sort((a, b) => b - a));
      await http().get('/api/v1/admin/users').query({ sort: 'password' }).set(bearer(admin)).expect(400);
    });
  });
});
