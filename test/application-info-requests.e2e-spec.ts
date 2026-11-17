/**
 * Application details and "request more information" (ADR-009; REG-05, REG-06, REG-10), Teacher and Coach:
 * new fields stored and returned; an Administrator asks a question (application stays PENDING, applicant e-mailed a
 * one-time link); the applicant reads and answers it (corrections applied, link consumed, administrators told);
 * a new question replaces an open one; a decision cancels an open request; rejection reasons are e-mailed;
 * permissions and invalid links are refused.
 */
import { createTestApp, login, bearer, waitForEvents, type TestContext } from './helpers.js';

const TEACHER_REGISTER = '/api/v1/auth/register/teacher';

describe('Application details and requests for more information (e2e)', () => {
  let ctx: TestContext;
  let admin: string, coach: string;
  let ngoma: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;

  /** The token of the newest e-mailed link to this address. */
  const tokenFor = async (email: string) => {
    const mail = await p().emailDelivery.findFirst({ where: { recipientEmail: email, body: { contains: 'applications/respond?token=' } }, orderBy: { createdAt: 'desc' } });
    const m = /applications\/respond\?token=([A-Za-z0-9_-]+)/.exec(mail?.body ?? '');
    if (!m) throw new Error(`no info-request link e-mailed to ${email}`);
    return m[1];
  };

  let n = 0;
  const teacherBody = (over: Record<string, unknown> = {}) => {
    n += 1;
    return {
      firstName: 'Grace', lastName: 'Teacher', username: `air.t${n}`, email: `air.t${n}@test.local`,
      password: 'Secret123', confirmPassword: 'Secret123', country: 'RW', phone: '0788123456',
      olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye', schoolId: ngoma,
      homeDistrict: 'Huye', homeSector: 'Ngoma', ...over,
    };
  };
  const coachBody = (over: Record<string, unknown> = {}) => {
    n += 1;
    return { firstName: 'Eric', lastName: 'Coach', username: `air.c${n}`, email: `air.c${n}@test.local`, password: 'Mentor123', ...over };
  };

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    coach = await login(ctx, 'mentor.j');
    ngoma = (await p().school.create({ data: {
      name: 'gs ngoma air', code: '229901', nameKey: 'gs ngoma air', location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST',
      province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
    } })).id;
    await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.teacherSelfSignup': true }).expect(200);
  });

  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('Teacher: position and years of experience are stored and shown to administrators; out-of-range years refused', async () => {
    const res = await http().post(TEACHER_REGISTER).send(teacherBody({ position: 'Head of Mathematics', yearsOfExperience: 7 })).expect(201);
    const view = await http().get(`/api/v1/admin/teacher-applications/${res.body.id}`).set(bearer(admin)).expect(200);
    expect(view.body).toMatchObject({ position: 'Head of Mathematics', yearsOfExperience: 7, infoRequests: [] });
    await http().post(TEACHER_REGISTER).send(teacherBody({ yearsOfExperience: 61 })).expect(400);
    await http().post(TEACHER_REGISTER).send(teacherBody({ position: 'x' })).expect(400);
  });

  it('Coach: phone (E.164), affiliation, expertise, experience are stored; an invalid phone is refused', async () => {
    const res = await http().post('/api/v1/mentor-requests').send(coachBody({
      phone: '0788 555 111', affiliation: 'University of Rwanda', expertise: 'Combinatorics, number theory',
      relevantExperience: 'IMO team leader 2023–2025', yearsOfExperience: 5,
    })).expect(201);
    const row = await p().mentorRequest.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ phone: '+250788555111', affiliation: 'University of Rwanda', yearsOfExperience: 5 });
    await http().post('/api/v1/mentor-requests').send(coachBody({ phone: '12' })).expect(400);
  });

  it('Teacher: request → e-mailed link → view → answer with corrections → PENDING again, administrators told; link used once', async () => {
    const body = teacherBody({ position: 'Teacher' });
    const app = (await http().post(TEACHER_REGISTER).send(body).expect(201)).body.id as string;
    const asked = await http().post(`/api/v1/admin/teacher-applications/${app}/request-info`).set(bearer(admin))
      .send({ question: 'Which classes do you teach?' }).expect(200);
    expect(asked.body.status).toBe('PENDING');
    expect(asked.body.infoRequests[0]).toMatchObject({ question: 'Which classes do you teach?', answeredAt: null, cancelledAt: null });
    expect(asked.body.infoRequests[0].tokenHash).toBeUndefined();
    expect(await p().auditLog.count({ where: { action: 'APPLICATION_INFO_REQUESTED', entityId: app } })).toBe(1);

    const token = await tokenFor(body.email);
    const view = await http().get(`/api/v1/applications/info-requests/${token}`).expect(200);
    expect(view.body).toMatchObject({ kind: 'TEACHER', firstName: 'Grace', question: 'Which classes do you teach?', correctable: ['phone', 'position', 'yearsOfExperience'] });
    expect(view.body.details).toMatchObject({ position: 'Teacher' });
    expect(JSON.stringify(view.body)).not.toContain('passwordHash');

    const admins = (await p().user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true }, select: { id: true } })).map((u) => u.id);
    const before = await p().notification.count({ where: { type: 'application.info_answered', userId: { in: admins } } });
    await http().post(`/api/v1/applications/info-requests/${token}`)
      .send({ answer: 'S4–S6 mathematics.', position: 'Senior mathematics teacher', yearsOfExperience: 9, affiliation: 'ignored for teachers' }).expect(200);
    await waitForEvents();
    const after = await http().get(`/api/v1/admin/teacher-applications/${app}`).set(bearer(admin)).expect(200);
    expect(after.body).toMatchObject({ status: 'PENDING', position: 'Senior mathematics teacher', yearsOfExperience: 9 });
    expect(after.body.infoRequests[0]).toMatchObject({ answer: 'S4–S6 mathematics.' });
    expect(after.body.infoRequests[0].answeredAt).not.toBeNull();
    expect(await p().notification.count({ where: { type: 'application.info_answered', userId: { in: admins } } })).toBe(before + admins.length);

    // Used once.
    await http().get(`/api/v1/applications/info-requests/${token}`).expect(410);
    await http().post(`/api/v1/applications/info-requests/${token}`).send({ answer: 'again' }).expect(410);
  });

  it('a new question replaces an unanswered one (the old link stops working); a decision cancels the open one', async () => {
    const body = teacherBody();
    const app = (await http().post(TEACHER_REGISTER).send(body).expect(201)).body.id as string;
    await http().post(`/api/v1/admin/teacher-applications/${app}/request-info`).set(bearer(admin)).send({ question: 'First question?' }).expect(200);
    const first = await tokenFor(body.email);
    await http().post(`/api/v1/admin/teacher-applications/${app}/request-info`).set(bearer(admin)).send({ question: 'Second question?' }).expect(200);
    const second = await tokenFor(body.email);
    expect(second).not.toBe(first);
    await http().get(`/api/v1/applications/info-requests/${first}`).expect(410);
    await http().get(`/api/v1/applications/info-requests/${second}`).expect(200);

    // Rejecting cancels the open question and e-mails the reason.
    await http().post(`/api/v1/admin/teacher-applications/${app}/reject`).set(bearer(admin)).send({ reason: 'School could not be confirmed.' }).expect(200);
    await http().get(`/api/v1/applications/info-requests/${second}`).expect(410);
    const open = await p().applicationInfoRequest.count({ where: { teacherApplicationId: app, answeredAt: null, cancelledAt: null } });
    expect(open).toBe(0);
    const mail = await p().emailDelivery.findFirst({ where: { recipientEmail: body.email, subject: { contains: 'teacher application' } }, orderBy: { createdAt: 'desc' } });
    expect(mail?.body).toContain('School could not be confirmed.');
    // A decided application takes no new question.
    await http().post(`/api/v1/admin/teacher-applications/${app}/request-info`).set(bearer(admin)).send({ question: 'Too late?' }).expect(409);
  });

  it('Coach: request, answer with corrections (phone normalised), reject with a reason that is e-mailed', async () => {
    const body = coachBody();
    const app = (await http().post('/api/v1/mentor-requests').send(body).expect(201)).body.id as string;
    const asked = await http().post(`/api/v1/mentor-requests/${app}/request-info`).set(bearer(admin))
      .send({ question: 'Please give your affiliation and phone.' }).expect(200);
    expect(asked.body.infoRequests[0]).toMatchObject({ question: 'Please give your affiliation and phone.' });
    const token = await tokenFor(body.email);
    const view = await http().get(`/api/v1/applications/info-requests/${token}`).expect(200);
    expect(view.body.kind).toBe('COACH');
    await http().post(`/api/v1/applications/info-requests/${token}`).send({ answer: 'Here they are.', phone: 'bad' }).expect(400);
    await http().post(`/api/v1/applications/info-requests/${token}`)
      .send({ answer: 'Here they are.', phone: '0788 000 222', affiliation: 'Kigali Maths Club', position: 'ignored for coaches' }).expect(200);
    const row = await p().mentorRequest.findUniqueOrThrow({ where: { id: app } });
    expect(row).toMatchObject({ status: 'PENDING', phone: '+250788000222', affiliation: 'Kigali Maths Club' });

    await http().patch(`/api/v1/mentor-requests/${app}/reject`).set(bearer(admin)).send({ reason: 'We need a coach with competition experience.' }).expect(200);
    await waitForEvents();
    expect((await p().mentorRequest.findUniqueOrThrow({ where: { id: app } })).rejectionReason).toBe('We need a coach with competition experience.');
    const mail = await p().emailDelivery.findFirst({ where: { recipientEmail: body.email, subject: { contains: 'coach application' } }, orderBy: { createdAt: 'desc' } });
    expect(mail?.body).toContain('We need a coach with competition experience.');
  });

  it('approval cancels an open question (Coach)', async () => {
    const body = coachBody();
    const app = (await http().post('/api/v1/mentor-requests').send(body).expect(201)).body.id as string;
    await http().post(`/api/v1/mentor-requests/${app}/request-info`).set(bearer(admin)).send({ question: 'Anything else?' }).expect(200);
    const token = await tokenFor(body.email);
    await http().patch(`/api/v1/mentor-requests/${app}/approve`).set(bearer(admin)).expect(200);
    await http().get(`/api/v1/applications/info-requests/${token}`).expect(410);
  });

  it('only administrators with the permission may ask; invalid input and unknown links are refused', async () => {
    const t = (await http().post(TEACHER_REGISTER).send(teacherBody()).expect(201)).body.id as string;
    const c = (await http().post('/api/v1/mentor-requests').send(coachBody()).expect(201)).body.id as string;
    await http().post(`/api/v1/admin/teacher-applications/${t}/request-info`).set(bearer(coach)).send({ question: 'Hello there?' }).expect(403);
    await http().post(`/api/v1/mentor-requests/${c}/request-info`).set(bearer(coach)).send({ question: 'Hello there?' }).expect(403);
    await http().post(`/api/v1/mentor-requests/${c}/request-info`).send({ question: 'Hello there?' }).expect(401);
    await http().post(`/api/v1/mentor-requests/${c}/request-info`).set(bearer(admin)).send({ question: 'Hi' }).expect(400);
    await http().post('/api/v1/admin/teacher-applications/00000000-0000-4000-8000-000000000000/request-info').set(bearer(admin)).send({ question: 'Anyone there?' }).expect(404);
    await http().get('/api/v1/applications/info-requests/not-a-real-token-at-all-1234567890').expect(410);
    await http().get('/api/v1/applications/info-requests/short').expect(410);
  });

  it('an expired link is refused', async () => {
    const body = coachBody();
    const app = (await http().post('/api/v1/mentor-requests').send(body).expect(201)).body.id as string;
    await http().post(`/api/v1/mentor-requests/${app}/request-info`).set(bearer(admin)).send({ question: 'Still interested?' }).expect(200);
    const token = await tokenFor(body.email);
    await p().applicationInfoRequest.updateMany({ where: { mentorRequestId: app }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http().get(`/api/v1/applications/info-requests/${token}`).expect(410);
    await http().post(`/api/v1/applications/info-requests/${token}`).send({ answer: 'Yes' }).expect(410);
  });
});
