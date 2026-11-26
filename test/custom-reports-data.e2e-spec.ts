/**
 * Reports with any data (owner 2026-11-25), end to end:
 *  - the Administrators' sources (schools, learning, applications, administration): Administrators only; banking
 *    information: the Super Admin only; every source, sort and filter answers without a server error;
 *  - protected (personal) fields: only the Super Admin adds them; a shared report shows them blank to anyone else;
 *    bank account numbers always masked; every Super Admin run / download that shows them is audited (no values);
 *  - templates: only the Super Admin saves, changes or deletes one; every Administrator sees it (isTemplate) and can
 *    start a new report from it.
 */
import { FILTER_OPS, SOURCES } from '../src/custom-reports/report-sources.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

describe('Custom reports: any data, protected fields, templates (e2e)', () => {
  let ctx: TestContext;
  let admin: string, superAdmin: string, coach: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const R = '/api/v1/reports';

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    process.env.HEAD_COACHES_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash!;
    await p().user.create({ data: { username: 'crd.super', firstName: 'Super', lastName: 'Reports', email: 'crd.super@test.local', role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date(), gender: 'FEMALE' } });
    superAdmin = await login(ctx, 'crd.super');
    await p().user.update({ where: { id: ctx.ids.studentJunior }, data: { phone: '+250788111222', guardianPhone: '+250788333444', dateOfBirth: new Date('2010-05-06') } });
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    delete process.env.HEAD_COACHES_ENABLED;
    await ctx?.app.close();
  });

  it('the Super Admin\'s catalogue: every source, banking marked Super Admin only, protected fields marked', async () => {
    const cat = (await http().get(`${R}/sources`).set(bearer(superAdmin)).expect(200)).body;
    expect(cat.sources.map((s: any) => s.key).sort()).toEqual(Object.keys(SOURCES).sort());
    expect(cat.sources.find((s: any) => s.key === 'BANKING')).toMatchObject({ group: 'Administration', superAdminOnly: true });
    const students = cat.sources.find((s: any) => s.key === 'STUDENTS');
    expect(students.fields.filter((f: any) => f.protected).map((f: any) => f.key).sort())
      .toEqual(['dateOfBirth', 'guardianPhone', 'homeDistrict', 'homeProvince', 'homeSector', 'phone']);
    for (const s of cat.sources) expect(['People', 'Schools', 'Learning', 'Applications', 'Administration']).toContain(s.group);
  });

  it('every source, sort and filter answers without a server error (the Super Admin)', async () => {
    const failures: string[] = [];
    const sample = (type: string, values: string[] | null) =>
      type === 'date' ? '2026-01-01' : type === 'number' ? '1' : type === 'boolean' ? true : type === 'enum' || type === 'list' ? [values?.[0] ?? 'X'] : 'a';
    for (const src of Object.values(SOURCES)) {
      const columns = src.fields.map((f) => f.key);
      const base = { source: src.key, columns };
      const all = await http().post(`${R}/preview`).set(bearer(superAdmin)).send(base);
      if (all.status !== 201) failures.push(`${src.key} all columns → ${all.status} ${JSON.stringify(all.body).slice(0, 200)}`);
      for (const f of src.fields) {
        if (f.orderBy) for (const dir of ['asc', 'desc']) {
          const r = await http().post(`${R}/preview`).set(bearer(superAdmin)).send({ ...base, sort: [{ field: f.key, dir }] });
          if (r.status !== 201) failures.push(`${src.key} sort ${f.key} ${dir} → ${r.status}`);
        }
        if (f.where) for (const op of FILTER_OPS) {
          const value = sample(f.type, (f.values as string[] | undefined) ?? null);
          if (f.where(op, value) === null) continue;   // this condition does not apply to the field
          const r = await http().post(`${R}/preview`).set(bearer(superAdmin)).send({ ...base, filters: [{ field: f.key, op, value }] });
          if (r.status !== 201) failures.push(`${src.key} filter ${f.key} ${op} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it('Administrators\' sources: Administrators only; banking information: the Super Admin only', async () => {
    const schools = { source: 'SCHOOLS', columns: ['name', 'district', 'students'] };
    const r = await http().post(`${R}/preview`).set(bearer(admin)).send(schools).expect(201);
    expect(r.body.meta.total).toBe(await p().school.count());
    const banking = await http().post(`${R}/preview`).set(bearer(admin)).send({ source: 'BANKING', columns: ['userName', 'personalBankName'] });
    expect([banking.status, banking.body.code]).toEqual([400, 'INVALID_REPORT']);
    // A coach shown a report on an Administrators' source sees no row.
    const saved = await http().post(R).set(bearer(admin)).send({ name: 'All schools', ...schools }).expect(201);
    await http().put(`${R}/${saved.body.id}/grants`).set(bearer(admin)).send({ grants: [{ role: 'MENTOR', canView: true, canDownload: false, canEdit: false }] }).expect(200);
    const asCoach = await http().get(`${R}/${saved.body.id}/run`).set(bearer(coach));
    expect([asCoach.status, asCoach.body.meta?.total]).toEqual([200, 0]);
  });

  it('protected fields: refused for an Administrator; the Super Admin sees them (audited, no values); blank in a report shared with an Administrator', async () => {
    const def = { source: 'STUDENTS', columns: ['fullName', 'phone', 'guardianPhone', 'dateOfBirth'], filters: [{ field: 'phone', op: 'isNotEmpty' }] };
    const refused = await http().post(`${R}/preview`).set(bearer(admin)).send(def);
    expect([refused.status, refused.body.code]).toEqual([400, 'INVALID_REPORT']);
    expect(JSON.stringify(refused.body.details.problems)).toContain('only the Super Admin can add personal data');

    const before = await p().auditLog.count({ where: { action: 'REPORT_PERSONAL_DATA_SHOWN' } });
    const shown = await http().post(`${R}/preview`).set(bearer(superAdmin)).send(def).expect(201);
    expect(shown.body.rows.map((r: unknown[]) => r[1])).toContain('+250788111222');
    const audit = await p().auditLog.findMany({ where: { action: 'REPORT_PERSONAL_DATA_SHOWN' }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(await p().auditLog.count({ where: { action: 'REPORT_PERSONAL_DATA_SHOWN' } })).toBe(before + 1);
    expect(audit[0].metadata).toMatchObject({ source: 'STUDENTS', fields: ['phone', 'guardianPhone', 'dateOfBirth'], what: 'view' });
    expect(JSON.stringify(audit)).not.toContain('+250788111222');

    const saved = await http().post(R).set(bearer(superAdmin)).send({ name: 'Students with phones', ...def }).expect(201);
    await http().put(`${R}/${saved.body.id}/grants`).set(bearer(superAdmin)).send({ grants: [{ role: 'ADMIN', canView: true, canDownload: true, canEdit: false }] }).expect(200);
    const asAdmin = await http().get(`${R}/${saved.body.id}/run`).set(bearer(admin)).expect(200);
    expect(asAdmin.body.columns.map((c: any) => c.label)).toEqual(['Full name', 'Phone number (hidden: personal data)', "Guardian's phone (hidden: personal data)", 'Date of birth (hidden: personal data)']);
    expect(asAdmin.body.rows.every((r: unknown[]) => r[1] === null && r[2] === null && r[3] === null)).toBe(true);
    const csv = await http().get(`${R}/${saved.body.id}/export?format=csv`).set(bearer(admin)).expect(200);
    expect(csv.text).not.toContain('+250788');
  });

  it('bank account numbers: always masked, even for the Super Admin', async () => {
    const teacherId = (await p().user.create({ data: { username: 'crd.teacher', firstName: 'Bank', lastName: 'Teacher', email: 'crd.teacher@test.local', role: 'TEACHER', activatedAt: new Date() } })).id;
    await p().userBankDetails.upsert({
      where: { userId: teacherId }, update: { personalAccountNumber: '123456789012', schoolAccountNumber: '400100004567' },
      create: { userId: teacherId, personalAccountName: 'Bank Teacher', personalBankName: 'Umwalimu SACCO', personalAccountNumber: '123456789012', schoolAccountName: 'GS', schoolBankName: 'Umwalimu SACCO', schoolAccountNumber: '400100004567' },
    });
    const r = await http().post(`${R}/preview`).set(bearer(superAdmin))
      .send({ source: 'BANKING', columns: ['userEmail', 'status', 'personalAccountNumber', 'schoolAccountNumber'], filters: [{ field: 'userEmail', op: 'eq', value: 'crd.teacher@test.local' }] }).expect(201);
    expect(r.body.rows).toEqual([['crd.teacher@test.local', 'COMPLETE', '•••• 9012', '•••• 4567']]);
    const t = await http().post(`${R}/preview`).set(bearer(superAdmin))
      .send({ source: 'TEACHERS', columns: ['email', 'personalAccount', 'schoolAccount'], filters: [{ field: 'email', op: 'eq', value: 'crd.teacher@test.local' }] }).expect(201);
    expect(t.body.rows).toEqual([['crd.teacher@test.local', '•••• 9012', '•••• 4567']]);
    expect(JSON.stringify([r.body, t.body])).not.toMatch(/123456789012|400100004567/);
  });

  it('templates: the Super Admin saves one; every Administrator sees it and starts from it, but cannot change or delete it', async () => {
    const def = { source: 'SCHOOLS', columns: ['name', 'district', 'teachers'] };
    const byAdmin = await http().post(R).set(bearer(admin)).send({ name: 'Mine as template', ...def, isTemplate: true });
    expect([byAdmin.status, byAdmin.body.code]).toEqual([403, 'REPORT_TEMPLATE_SUPER_ADMIN_ONLY']);

    const tpl = await http().post(R).set(bearer(superAdmin)).send({ name: 'Schools and teachers', ...def, isTemplate: true }).expect(201);
    expect(tpl.body.isTemplate).toBe(true);
    const listed = (await http().get(R).set(bearer(admin)).expect(200)).body;
    expect(listed.find((x: any) => x.id === tpl.body.id)).toMatchObject({ isTemplate: true, name: 'Schools and teachers' });

    const change = await http().put(`${R}/${tpl.body.id}`).set(bearer(admin)).send({ name: 'Renamed', ...def });
    expect([change.status, change.body.code]).toEqual([403, 'REPORT_TEMPLATE_SUPER_ADMIN_ONLY']);
    const del = await http().delete(`${R}/${tpl.body.id}`).set(bearer(admin));
    expect([del.status, del.body.code]).toEqual([403, 'REPORT_TEMPLATE_SUPER_ADMIN_ONLY']);

    // Starting from it: a new report of the Administrator's own, with the template's definition.
    const copy = await http().post(R).set(bearer(admin)).send({ name: 'My schools report', ...def }).expect(201);
    expect(copy.body.isTemplate).toBe(false);

    // The Super Admin unmarks it; audited both ways.
    await http().put(`${R}/${tpl.body.id}`).set(bearer(superAdmin)).send({ name: 'Schools and teachers', ...def, isTemplate: false }).expect(200);
    expect((await http().get(`${R}/${tpl.body.id}`).set(bearer(admin)).expect(200)).body.isTemplate).toBe(false);
    expect(await p().auditLog.count({ where: { action: { in: ['REPORT_TEMPLATE_SET', 'REPORT_TEMPLATE_UNSET'] }, entityId: tpl.body.id } })).toBe(2);
  });
});
