/**
 * What an academic-year start does to every student (PERF-01 set-based rollover, B-M3 graduates).
 * Real PostgreSQL, real HTTP. The rollover is two SQL statements, so these tests pin its rules row
 * by row: promotion and division change, graduation, carry-over, suspended and withdrawn students,
 * students who never had an enrolment, the User mirror, timestamps and the recorded counts.
 *
 * Graduates (authorised fix): a student whose latest enrolment is GRADUATED is never enrolled again
 * automatically — whether the account was kept active (deactivateGraduates=false) or reactivated later.
 */
import { createTestApp, login, bearer, currentYearId, type TestContext } from './helpers.js';
import type { GradeLevel } from '../src/generated/prisma/client.js';

type Ctx = TestContext & { admin: string };

async function setup(): Promise<Ctx> {
  const ctx = await createTestApp();
  return Object.assign(ctx, { admin: await login(ctx, 'admin') });
}

/** A student placed in the current year (enrolment `status`, or none). */
async function student(ctx: Ctx, username: string, grade: GradeLevel, opts: { enrolment?: 'ACTIVE' | 'WITHDRAWN' | null; isActive?: boolean; school?: boolean } = {}) {
  const school = opts.school === false ? null : (await ctx.prisma.school.findFirstOrThrow()).id;
  const divisionId = ['S1', 'S2', 'S3'].includes(grade) ? ctx.ids.junior : ctx.ids.senior;
  const u = await ctx.prisma.user.create({
    data: {
      username, firstName: username, lastName: 'Roll', email: `${username}@test.local`, role: 'STUDENT',
      activatedAt: new Date(), isActive: opts.isActive ?? true, gradeLevel: grade, divisionId, schoolId: school,
    },
  });
  const enrolment = opts.enrolment === undefined ? 'ACTIVE' : opts.enrolment;
  if (enrolment) {
    await ctx.prisma.studentEnrollment.create({
      data: { studentId: u.id, academicYearId: ctx.ids.year, gradeLevel: grade, divisionId, schoolId: school, status: enrolment },
    });
  }
  return u.id;
}

const plan = async (ctx: Ctx, name: string, startsOn: string, endsOn: string) =>
  (await ctx.http().post('/api/v1/admin/academic-years').set(bearer(ctx.admin)).send({ name, startsOn, endsOn }).expect(201)).body.id as string;

const start = async (ctx: Ctx, id: string, choices: object) =>
  (await ctx.http().post(`/api/v1/admin/academic-years/${id}/activate`).set(bearer(ctx.admin))
    .send({ ...choices, expectedCurrentYearId: await currentYearId(ctx) }).expect(200)).body;

const enrolment = (ctx: Ctx, studentId: string, academicYearId: string) =>
  ctx.prisma.studentEnrollment.findUnique({ where: { studentId_academicYearId: { studentId, academicYearId } } });

const user = (ctx: Ctx, id: string) => ctx.prisma.user.findUniqueOrThrow({ where: { id } });

const auditCounts = async (ctx: Ctx, yearId: string) =>
  ((await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'ACTIVATE_ACADEMIC_YEAR', entityId: yearId } })).metadata as { counts: object }).counts;

describe('Academic-year start: promote with deactivateGraduates=false (API only)', () => {
  let ctx: Ctx;
  let grad: string, s1NoSchool: string, suspended: string, withdrawn: string, legacy: string;
  let y2: string;

  beforeAll(async () => {
    ctx = await setup();
    // Base students: student.j S2, student.j2 S3, student.s S5 (all enrolled, Test School).
    grad       = await student(ctx, 'roll.s6', 'S6');
    s1NoSchool = await student(ctx, 'roll.s1', 'S1', { school: false });
    suspended  = await student(ctx, 'roll.suspended', 'S4', { isActive: false });
    withdrawn  = await student(ctx, 'roll.withdrawn', 'S4', { enrolment: 'WITHDRAWN' });
    legacy     = await student(ctx, 'roll.legacy', 'S2', { enrolment: null });
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('promotes, graduates without deactivating, and never re-enrols the graduate (counts not doubled)', async () => {
    y2 = await plan(ctx, '2027-2028', '2027-09-01', '2028-07-31');
    const res = await start(ctx, y2, { promoteStudents: true, deactivateGraduates: false });

    // 4 promoted (j, j2, s, s1), 1 graduated; newly enrolled: the never-enrolled student and the
    // withdrawn-but-active one (unchanged rule) — NOT the graduate (before the fix: 3, graduate included).
    expect(res).toMatchObject({ promoted: 4, carriedOver: 0, graduated: 1, newlyEnrolled: 2, assignmentsArchived: 0 });
    expect(await auditCounts(ctx, y2)).toEqual({ promoted: 4, carriedOver: 0, graduated: 1, newlyEnrolled: 2, assignmentsArchived: 0 });

    const closedAt = (await ctx.prisma.academicYear.findUniqueOrThrow({ where: { id: ctx.ids.year } })).closedAt!;

    // The graduate: old enrolment GRADUATED (ended when the year closed), account still active,
    // placement unchanged, and NO enrolment in the new year.
    expect(await enrolment(ctx, grad, ctx.ids.year)).toMatchObject({ status: 'GRADUATED', endedAt: closedAt });
    expect(await user(ctx, grad)).toMatchObject({ isActive: true, gradeLevel: 'S6', divisionId: ctx.ids.senior });
    expect(await enrolment(ctx, grad, y2)).toBeNull();

    // S3 → S4 moves into the senior division; enrolment and User agree.
    expect(await enrolment(ctx, ctx.ids.studentJunior2, ctx.ids.year)).toMatchObject({ status: 'PROMOTED', endedAt: closedAt });
    expect(await enrolment(ctx, ctx.ids.studentJunior2, y2)).toMatchObject({
      status: 'ACTIVE', gradeLevel: 'S4', divisionId: ctx.ids.senior, endedAt: null, enrolledAt: closedAt,
    });
    expect(await user(ctx, ctx.ids.studentJunior2)).toMatchObject({ gradeLevel: 'S4', divisionId: ctx.ids.senior });
    // S5 → S6 stays senior; S2 → S3 stays junior; the school is carried.
    expect(await user(ctx, ctx.ids.studentSenior)).toMatchObject({ gradeLevel: 'S6', divisionId: ctx.ids.senior });
    expect(await enrolment(ctx, ctx.ids.studentJunior, y2)).toMatchObject({ gradeLevel: 'S3', divisionId: ctx.ids.junior });
    expect((await enrolment(ctx, ctx.ids.studentJunior, y2))!.schoolId).toBe((await user(ctx, ctx.ids.studentJunior)).schoolId);
    expect((await user(ctx, ctx.ids.studentJunior)).schoolId).not.toBeNull();
    // No school stays no school.
    expect(await enrolment(ctx, s1NoSchool, y2)).toMatchObject({ gradeLevel: 'S2', divisionId: ctx.ids.junior, schoolId: null });
    expect(await user(ctx, s1NoSchool)).toMatchObject({ gradeLevel: 'S2', schoolId: null });

    // A suspended student is not rolled over at all.
    expect(await enrolment(ctx, suspended, ctx.ids.year)).toMatchObject({ status: 'ACTIVE', endedAt: null });
    expect(await enrolment(ctx, suspended, y2)).toBeNull();
    expect(await user(ctx, suspended)).toMatchObject({ gradeLevel: 'S4', isActive: false });

    // Withdrawn enrolment: untouched; the active account is enrolled at its current grade (as before).
    expect(await enrolment(ctx, withdrawn, ctx.ids.year)).toMatchObject({ status: 'WITHDRAWN' });
    expect(await enrolment(ctx, withdrawn, y2)).toMatchObject({ status: 'ACTIVE', gradeLevel: 'S4', divisionId: ctx.ids.senior });
    // Never enrolled: enrolled at the current grade.
    expect(await enrolment(ctx, legacy, y2)).toMatchObject({ status: 'ACTIVE', gradeLevel: 'S2', divisionId: ctx.ids.junior });

    // Every active student except the graduate has exactly one ACTIVE enrolment in the new year.
    expect(await ctx.prisma.studentEnrollment.count({ where: { academicYearId: y2, status: 'ACTIVE' } })).toBe(6);
  });

  it('a graduate kept active is not swept into later years either; the next S6 class graduates', async () => {
    const y3 = await plan(ctx, '2028-2029', '2028-09-01', '2029-07-31');
    const res = await start(ctx, y3, { promoteStudents: true, deactivateGraduates: true });
    // student.s (S6 now) graduates and is deactivated; the earlier graduate is still active but skipped.
    expect(res).toMatchObject({ graduated: 1, newlyEnrolled: 0 });
    expect(await enrolment(ctx, grad, y3)).toBeNull();
    expect(await user(ctx, grad)).toMatchObject({ isActive: true, gradeLevel: 'S6' });
    expect(await enrolment(ctx, ctx.ids.studentSenior, y2)).toMatchObject({ status: 'GRADUATED' });
    expect(await user(ctx, ctx.ids.studentSenior)).toMatchObject({ isActive: false });
  });

  it('a graduate whose account is reactivated later is not re-enrolled by the next start', async () => {
    await ctx.http().patch(`/api/v1/admin/users/${ctx.ids.studentSenior}/status`).set(bearer(ctx.admin))
      .send({ isActive: true }).expect(200);
    const y4 = await plan(ctx, '2029-2030', '2029-09-01', '2030-07-31');
    const res = await start(ctx, y4, { promoteStudents: true, deactivateGraduates: true });
    expect(res.newlyEnrolled).toBe(0);
    expect(await enrolment(ctx, ctx.ids.studentSenior, y4)).toBeNull();
    expect(await user(ctx, ctx.ids.studentSenior)).toMatchObject({ isActive: true, gradeLevel: 'S6' });
    expect(await ctx.prisma.studentEnrollment.count({ where: { studentId: ctx.ids.studentSenior, status: 'ACTIVE' } })).toBe(0);
  });
});

describe('Academic-year start: promote with deactivateGraduates=true (the admin UI choice), then carry over', () => {
  let ctx: Ctx;
  let grad: string;

  beforeAll(async () => {
    ctx = await setup();
    grad = await student(ctx, 'roll.s6', 'S6');
  });
  afterAll(async () => { await ctx?.app.close(); });

  it('graduates S6 and deactivates them; no new enrolment; others promoted', async () => {
    const y2 = await plan(ctx, '2027-2028', '2027-09-01', '2028-07-31');
    const res = await start(ctx, y2, { promoteStudents: true, deactivateGraduates: true });
    expect(res).toMatchObject({ promoted: 3, carriedOver: 0, graduated: 1, newlyEnrolled: 0 });
    expect(await enrolment(ctx, grad, ctx.ids.year)).toMatchObject({ status: 'GRADUATED' });
    expect(await enrolment(ctx, grad, y2)).toBeNull();
    expect(await user(ctx, grad)).toMatchObject({ isActive: false, gradeLevel: 'S6' });
  });

  it('promoteStudents=false carries everyone over at the same grade (S6 included), old enrolment ended but ACTIVE', async () => {
    const y2 = await currentYearId(ctx);
    const y3 = await plan(ctx, '2028-2029', '2028-09-01', '2029-07-31');
    const res = await start(ctx, y3, { promoteStudents: false });
    expect(res).toMatchObject({ promoted: 0, carriedOver: 3, graduated: 0, newlyEnrolled: 0 });
    const closedAt = (await ctx.prisma.academicYear.findUniqueOrThrow({ where: { id: y2! } })).closedAt!;
    expect(await enrolment(ctx, ctx.ids.studentSenior, y2!)).toMatchObject({ status: 'ACTIVE', gradeLevel: 'S6', endedAt: closedAt });
    expect(await enrolment(ctx, ctx.ids.studentSenior, y3)).toMatchObject({ status: 'ACTIVE', gradeLevel: 'S6', endedAt: null });
    expect(await user(ctx, ctx.ids.studentSenior)).toMatchObject({ gradeLevel: 'S6', divisionId: ctx.ids.senior });
    // The graduate deactivated a year ago stays out.
    expect(await enrolment(ctx, grad, y3)).toBeNull();
  });
});
