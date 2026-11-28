/**
 * Submission reports (owner 2026-11-28): every submitted answer, one row per submission (a reassigned one counted once),
 * with its corrections (original test / subject / level, reason, who, when); filters and summary statistics; PDF, Excel
 * and CSV with ROF formatting; sharing with users, roles and schools, view-only or view-and-download, expiry, revocation,
 * an access log — all enforced by the API, never widening the rows (Teachers: their schools' students; Head Coaches:
 * their subjects; Coaches never — blind marking; Students never).
 * With REPORT_SAMPLES_DIR set, the PDF and Excel exports are written there (samples for the owner).
 */
import { randomUUID } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import ExcelJS from 'exceljs';
import { createTestApp, login, bearer, PDF, type TestContext } from './helpers.js';

const minutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};

describe('Submission reports (e2e)', () => {
  let ctx: TestContext;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  const T = '/api/v1/admin/tests';
  const R = '/api/v1/reports';
  let admin: string, superAdmin: string, headCoach: string, coach: string, teacherA: string, teacherB: string, sj: string, ss: string;
  let maths: string, physics: string, computing: string;
  let mathsJunior: string, mathsSenior: string, physicsAll: string, computingAll: string;
  let teacherAId: string, coachId: string, otherSchool: string, testSchool: string;
  let report: string;
  let movedSub: string, movedSub2: string, plainSub: string;

  const newTest = async (title: string, subjectId: string, division: string) => {
    const res = await http().post(T).set(bearer(admin)).send({
      title, subjectId, division, answerFormat: 'BOTH', opensAt: minutes(-60), closesAt: minutes(120), maxMarks: 10,
      questions: [{ prompt: 'Question 1', maxMarks: 10 }],
    }).expect(201);
    await http().put(`${T}/${res.body.id}/files/marking-guide`).set(bearer(admin)).attach('file', PDF, 'guide.pdf').expect(200);
    await http().post(`${T}/${res.body.id}/publish`).set(bearer(admin)).expect(200);
    return res.body.id as string;
  };
  const submit = async (token: string, testId: string, studentId: string) => {
    await http().post(`/api/v1/me/tests/${testId}/submission`).set(bearer(token)).send({ clientKey: randomUUID(), typedAnswer: 'My working' }).expect(201);
    return (await p().testSubmission.findUniqueOrThrow({ where: { testId_studentId: { testId, studentId } } })).id;
  };
  const reassign = (testId: string, subId: string, body: Record<string, unknown>) =>
    http().post(`${T}/${testId}/submissions/${subId}/reassignment`).set(bearer(admin)).send(body).expect(200);
  const setGrants = (token: string, grants: object[]) => http().put(`${R}/${report}/grants`).set(bearer(token)).send({ grants });
  const run = (token: string) => http().get(`${R}/${report}/run`).query({ limit: 200 }).set(bearer(token));
  const rowsOf = (body: any) => body.rows as Array<Array<unknown>>;
  const col = (body: any, key: string) => body.columns.findIndex((c: any) => c.key === key);
  const download = (token: string, format: string) => http().get(`${R}/${report}/export`).query({ format }).set(bearer(token)).buffer(true).parse(binary);

  beforeAll(async () => {
    process.env.HEAD_COACHES_ENABLED = 'true';
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    maths = (await p().discipline.findUniqueOrThrow({ where: { code: 'MATHEMATICS' } })).id;
    physics = (await p().discipline.create({ data: { code: 'SR_PHYSICS', name: 'Physics' } })).id;
    computing = (await p().discipline.create({ data: { code: 'SR_COMPUTING', name: 'Computing' } })).id;
    const pw = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
    const mk = async (username: string, role: 'SUPER_ADMIN' | 'HEAD_COACH' | 'TEACHER') =>
      (await p().user.create({ data: { username, firstName: username, lastName: 'Sr', email: `${username}@test.local`, role, passwordHash: pw, activatedAt: new Date(), isApproved: true } })).id;
    await mk('sr.super', 'SUPER_ADMIN');
    const hc = await mk('sr.head', 'HEAD_COACH');
    await p().programmeMembership.create({ data: { userId: hc, disciplineId: maths, source: 'MANUAL' } });
    teacherAId = await mk('sr.teacher.a', 'TEACHER');
    const teacherBId = await mk('sr.teacher.b', 'TEACHER');
    coachId = (await p().user.findUniqueOrThrow({ where: { username: 'mentor.j' } })).id;
    // Schools: student.j at Test School (teacher A), student.s at Other School (teacher B).
    testSchool = (await p().school.findFirstOrThrow({ where: { name: 'Test School' } })).id;
    otherSchool = (await p().school.create({ data: { name: 'Other School', location: 'Huye' } })).id;
    await p().user.update({ where: { id: ctx.ids.studentSenior }, data: { schoolId: otherSchool } });
    await p().studentSchoolAffiliation.create({ data: { studentId: ctx.ids.studentJunior, schoolId: testSchool, status: 'VERIFIED', source: 'ADMIN', decidedById: ctx.ids.admin, decidedAt: new Date() } });
    await p().studentSchoolAffiliation.create({ data: { studentId: ctx.ids.studentSenior, schoolId: otherSchool, status: 'VERIFIED', source: 'ADMIN', decidedById: ctx.ids.admin, decidedAt: new Date() } });
    await p().teacherSchoolAssignment.create({ data: { teacherId: teacherAId, schoolId: testSchool, assignedById: ctx.ids.admin } });
    await p().teacherSchoolAssignment.create({ data: { teacherId: teacherBId, schoolId: otherSchool, assignedById: ctx.ids.admin } });
    admin = await login(ctx, 'admin');
    superAdmin = await login(ctx, 'sr.super');
    headCoach = await login(ctx, 'sr.head');
    coach = await login(ctx, 'mentor.j');
    teacherA = await login(ctx, 'sr.teacher.a');
    teacherB = await login(ctx, 'sr.teacher.b');
    sj = await login(ctx, 'student.j');
    ss = await login(ctx, 'student.s');

    mathsJunior = await newTest('Mathematics Round 1 Junior', maths, 'JUNIOR');
    mathsSenior = await newTest('Mathematics Round 1 Senior', maths, 'SENIOR');
    physicsAll = await newTest('Physics Round 1', physics, 'ALL');
    computingAll = await newTest('Computing Round 1', computing, 'ALL');
    // student.j: Junior Mathematics → Senior Mathematics; student.s: Physics → Computing; student.j: Physics (no correction).
    movedSub = await submit(sj, mathsJunior, ctx.ids.studentJunior);
    await reassign(mathsJunior, movedSub, { testId: mathsSenior, level: 'SENIOR', reason: 'Student is in S5; chose the Junior test by mistake' });
    movedSub2 = await submit(ss, physicsAll, ctx.ids.studentSenior);
    await reassign(physicsAll, movedSub2, { testId: computingAll, level: 'SENIOR', reason: 'Submitted under Physics instead of Computing' });
    plainSub = await submit(sj, physicsAll, ctx.ids.studentJunior);

    const created = await http().post(R).set(bearer(admin)).send({
      name: 'Submissions and corrections', description: 'Every submitted answer this round, with corrections', source: 'SUBMISSIONS',
      columns: ['studentName', 'school', 'subject', 'level', 'test', 'submittedAt', 'status', 'corrected', 'originalTest', 'originalSubject', 'originalLevel', 'correctionReason', 'correctedBy', 'correctedAt'],
      filters: [], sort: [],
    }).expect(201);
    report = created.body.id;
  });
  afterAll(async () => {
    delete process.env.HEAD_COACHES_ENABLED; delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('a reassignment writes one append-only correction (before, after, reason, who); it can be neither changed nor removed', async () => {
    const c = await p().testSubmissionCorrection.findMany({ where: { submissionId: movedSub } });
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ actorId: ctx.ids.admin, fromTestId: mathsJunior, fromTestTitle: 'Mathematics Round 1 Junior', fromLevel: 'JUNIOR', toTestId: mathsSenior, toLevel: 'SENIOR', fromSubjectName: 'Mathematics', toSubjectName: 'Mathematics' });
    await expect(p().testSubmissionCorrection.update({ where: { id: c[0].id }, data: { reason: 'changed' } })).rejects.toThrow(/append-only/);
    await expect(p().testSubmissionCorrection.delete({ where: { id: c[0].id } })).rejects.toThrow(/append-only/);
  });

  it('one row per submission — a moved answer counted once — with original and corrected details; filters', async () => {
    const r = (await run(admin).expect(200)).body;
    expect(r.meta.total).toBe(3);
    expect(r.meta.total).toBe(await p().testSubmission.count({ where: { versionCount: { gt: 0 } } }));
    const byTest = (title: string) => rowsOf(r).find((row) => row[col(r, 'test')] === title)!;
    const moved = byTest('Mathematics Round 1 Senior');
    expect(moved[col(r, 'level')]).toBe('Senior');
    expect(moved[col(r, 'corrected')]).toBe(true);
    expect(moved[col(r, 'originalTest')]).toBe('Mathematics Round 1 Junior');
    expect(moved[col(r, 'originalLevel')]).toBe('Junior');
    expect(moved[col(r, 'correctionReason')]).toBe('Student is in S5; chose the Junior test by mistake');
    expect(moved[col(r, 'correctedBy')]).toBe('admin Test');
    expect(moved[col(r, 'correctedAt')]).toBeTruthy();
    const physicsToComputing = byTest('Computing Round 1');
    expect([physicsToComputing[col(r, 'subject')], physicsToComputing[col(r, 'originalSubject')]]).toEqual(['Computing', 'Physics']);
    const plain = byTest('Physics Round 1');
    expect([plain[col(r, 'corrected')], plain[col(r, 'originalTest')]]).toEqual([false, null]);
    expect(rowsOf(r).some((row) => row[col(r, 'test')] === 'Mathematics Round 1 Junior')).toBe(false);   // never under its old test
    // Filters: corrected only; one subject.
    const corrected = (await http().post(`${R}/preview`).set(bearer(admin)).send({ source: 'SUBMISSIONS', columns: ['test'], filters: [{ field: 'corrected', op: 'eq', value: true }], sort: [] }).expect(201)).body;
    expect(corrected.meta.total).toBe(2);
    const physicsOnly = (await http().post(`${R}/preview`).set(bearer(admin)).send({ source: 'SUBMISSIONS', columns: ['test'], filters: [{ field: 'subject', op: 'eq', value: 'Physics' }], sort: [] }).expect(201)).body;
    expect(physicsOnly.rows).toEqual([['Physics Round 1']]);
  });

  it('summary statistics: totals by status, subject, level, school and corrected', async () => {
    const s = (await http().get(`${R}/${report}/summary`).set(bearer(admin)).expect(200)).body;
    expect(s.total).toBe(3);
    const g = Object.fromEntries(s.groups.map((x: any) => [x.key, Object.fromEntries(x.counts.map((c: any) => [c.value, c.count]))]));
    expect(g.subject).toEqual({ Mathematics: 1, Physics: 1, Computing: 1 });
    expect(g.corrected).toEqual({ Yes: 2, No: 1 });
    expect(g.school).toEqual({ 'Test School': 2, 'Other School': 1 });
    expect(g.level).toEqual({ Senior: 2, Junior: 1 });
  });

  it('PDF, Excel and CSV with ROF formatting; downloads are audited', async () => {
    const pdf = await download(admin, 'pdf').expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['cache-control']).toBe('private, no-store');
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.body.length).toBeGreaterThan(5_000);
    const xlsx = await download(admin, 'xlsx').expect(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx.body);
    const ws = wb.worksheets[0];
    expect(ws.getCell('B1').value).toBe('RWANDA OLYMPIAD FOUNDATION');
    expect(ws.getCell('B2').value).toBe('Submissions and corrections');
    expect(String(ws.getCell('B5').value)).toMatch(/^Generated by admin Test on .* \(Kigali time\) · 3 rows/);
    expect(ws.getRow(7).getCell(1).value).toBe('Student name');
    expect((ws.getRow(7).getCell(1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FF00428C');
    expect(ws.rowCount).toBe(7 + 3);
    expect(wb.getWorksheet('Summary')).toBeTruthy();
    const csv = await http().get(`${R}/${report}/export`).query({ format: 'csv' }).set(bearer(admin)).expect(200);
    expect(csv.text.split('\n')[0]).toContain('Original test');
    const dir = process.env.REPORT_SAMPLES_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'submission-report-sample.pdf'), pdf.body);
      writeFileSync(join(dir, 'submission-report-sample.xlsx'), xlsx.body);
      writeFileSync(join(dir, 'submission-report-sample.csv'), csv.text);
    }
    const exported = await p().auditLog.findMany({ where: { action: 'REPORT_EXPORTED', entityId: report }, select: { actorId: true, metadata: true } });
    expect(exported.map((e) => (e.metadata as any).format).sort()).toEqual(['csv', 'pdf', 'xlsx']);
  });

  it('scopes: a school grant gives that school\'s teachers their own students only; another school sees nothing; a Head Coach their subjects', async () => {
    await setGrants(admin, [{ schoolId: testSchool, canView: true, canDownload: false, canEdit: false }, { role: 'HEAD_COACH', canView: true, canDownload: true, canEdit: false }]).expect(200);
    const a = (await run(teacherA).expect(200)).body;
    expect(a.meta.total).toBe(2);   // student.j's two answers; never student.s (Other School)
    expect(rowsOf(a).every((row) => row[col(a, 'school')] === 'Test School')).toBe(true);
    await run(teacherB).expect(404);   // no grant for Other School
    // View only: no download.
    const dl = await http().get(`${R}/${report}/export`).query({ format: 'pdf' }).set(bearer(teacherA));
    expect([dl.status, dl.body.code]).toEqual([403, 'REPORT_ACCESS_DENIED']);
    // The Head Coach of Mathematics: Mathematics answers only.
    const hc = (await run(headCoach).expect(200)).body;
    expect(rowsOf(hc).map((row) => row[col(hc, 'subject')])).toEqual(['Mathematics']);
    await download(headCoach, 'xlsx').expect(200);
    // Teachers see the report in their list (through their school), Students never.
    expect((await http().get(R).set(bearer(teacherA)).expect(200)).body.map((x: any) => x.id)).toContain(report);
    expect((await http().get(R).set(bearer(teacherB)).expect(200)).body.map((x: any) => x.id)).not.toContain(report);
  });

  it('blind marking and students: Coaches and Students can never be given a submission report; even a forced grant shows a Coach nothing', async () => {
    for (const g of [{ role: 'MENTOR' }, { userId: coachId }, { role: 'STUDENT' }, { userId: ctx.ids.studentJunior }]) {
      const r = await setGrants(admin, [{ ...g, canView: true, canDownload: false, canEdit: false }]);
      expect([r.status, r.body.code]).toEqual([400, 'GRANTEE_NOT_ALLOWED']);
    }
    // Defence in depth: a grant written behind the API's back still shows a Coach no row.
    await p().customReportGrant.create({ data: { reportId: report, grantee: `user:${coachId}`, userId: coachId, canView: true, canDownload: true, canEdit: false } });
    const c = (await run(coach).expect(200)).body;
    expect(c.meta.total).toBe(0);
    await p().customReportGrant.deleteMany({ where: { reportId: report, userId: coachId } });
    // Students: no level at all.
    await run(sj).expect(404);
    await run(ss).expect(404);
  });

  it('expiry and revocation: an expired or revoked grant gives nothing; revocation is kept in the history; granting again restores it', async () => {
    const past = await setGrants(admin, [{ schoolId: testSchool, canView: true, canDownload: false, canEdit: false, expiresAt: new Date(Date.now() - 60_000).toISOString() }]);
    expect([past.status, past.body.code]).toEqual([400, 'EXPIRY_IN_PAST']);
    await setGrants(admin, [{ schoolId: testSchool, canView: true, canDownload: true, canEdit: false, expiresAt: minutes(60) }]).expect(200);
    await run(teacherA).expect(200);
    // Time passes: the expiry is reached.
    await p().customReportGrant.updateMany({ where: { reportId: report, schoolId: testSchool }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await run(teacherA).expect(404);
    let list = (await http().get(`${R}/${report}/grants`).set(bearer(admin)).expect(200)).body.grants;
    expect(list.find((g: any) => g.school?.id === testSchool).state).toBe('EXPIRED');
    // Renewed, then revoked (one grant): gone for the teacher, kept for the history.
    await setGrants(admin, [{ schoolId: testSchool, canView: true, canDownload: false, canEdit: false }]).expect(200);
    await run(teacherA).expect(200);
    const grant = (await http().get(`${R}/${report}/grants`).set(bearer(admin)).expect(200)).body.grants.find((g: any) => g.school?.id === testSchool);
    await http().post(`${R}/${report}/grants/${grant.id}/revoke`).set(bearer(admin)).expect(201);
    await run(teacherA).expect(404);
    list = (await http().get(`${R}/${report}/grants`).set(bearer(admin)).expect(200)).body.grants;
    expect(list.find((g: any) => g.id === grant.id)).toMatchObject({ state: 'REVOKED' });
    expect(await p().customReportGrant.count({ where: { id: grant.id } })).toBe(1);
    // Removing a grant through the list revokes it too (never deleted).
    await setGrants(admin, [{ role: 'HEAD_COACH', canView: true, canDownload: false, canEdit: false }]).expect(200);
    await setGrants(admin, []).expect(200);
    expect(await p().customReportGrant.count({ where: { reportId: report, role: 'HEAD_COACH', revokedAt: { not: null } } })).toBe(1);
    await run(headCoach).expect(404);
    // Granting again restores it.
    await setGrants(admin, [{ schoolId: testSchool, canView: true, canDownload: false, canEdit: false }]).expect(200);
    await run(teacherA).expect(200);
  });

  it('access log: views, downloads and access changes, with who and when (only for who manages the report)', async () => {
    const log = (await http().get(`${R}/${report}/access-log`).set(bearer(admin)).expect(200)).body.entries;
    const actions = new Set(log.map((e: any) => e.action));
    for (const a of ['REPORT_VIEWED', 'REPORT_EXPORTED', 'REPORT_GRANTS_SET', 'REPORT_GRANT_REVOKED']) expect(actions.has(a)).toBe(true);
    const teacherViews = log.filter((e: any) => e.action === 'REPORT_VIEWED' && e.actor?.id === teacherAId);
    expect(teacherViews.length).toBeGreaterThan(0);
    expect(log.find((e: any) => e.action === 'REPORT_EXPORTED' && e.format === 'pdf')).toBeTruthy();
    // A viewer may not read the log or change access.
    const denied = await http().get(`${R}/${report}/access-log`).set(bearer(teacherA));
    expect([denied.status, denied.body.code]).toEqual([403, 'REPORT_ACCESS_DENIED']);
    expect((await setGrants(teacherA, [])).status).toBe(403);
    // A Super Administrator may (and sees the same rows).
    await http().get(`${R}/${report}/access-log`).set(bearer(superAdmin)).expect(200);
  });

  it('building a submission report needs reports.build: Head Coaches, Teachers, Coaches and Students cannot preview or create one', async () => {
    for (const token of [headCoach, teacherA, coach, sj]) {
      const r = await http().post(`${R}/preview`).set(bearer(token)).send({ source: 'SUBMISSIONS', columns: ['test'], filters: [], sort: [] });
      expect(r.status).toBe(403);
    }
  });
});
