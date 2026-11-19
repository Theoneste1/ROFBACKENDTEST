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
    return { firstName: 'Eric', lastName: 'Coach', username: `air.c${n}`, email: `air.c${n}@test.local`, password: 'Mentor123', olympiadInterests: ['MATHEMATICS'], ...over };
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
    const view = await http().post('/api/v1/applications/info-requests/view').send({ token: token }).expect(200);
    expect(view.body).toMatchObject({ kind: 'TEACHER', firstName: 'Grace', question: 'Which classes do you teach?', correctable: ['phone', 'position', 'yearsOfExperience'] });
    expect(view.body.details).toMatchObject({ position: 'Teacher' });
    expect(JSON.stringify(view.body)).not.toContain('passwordHash');

    const admins = (await p().user.findMany({ where: { role: { in: ['ADMIN', 'SUPER_ADMIN'] }, isActive: true }, select: { id: true } })).map((u) => u.id);
    const before = await p().notification.count({ where: { type: 'application.info_answered', userId: { in: admins } } });
    await http().post('/api/v1/applications/info-requests/answer').send({ token: token,  answer: 'S4–S6 mathematics.', position: 'Senior mathematics teacher', yearsOfExperience: 9, affiliation: 'ignored for teachers' }).expect(200);
    await waitForEvents();
    const after = await http().get(`/api/v1/admin/teacher-applications/${app}`).set(bearer(admin)).expect(200);
    expect(after.body).toMatchObject({ status: 'PENDING', position: 'Senior mathematics teacher', yearsOfExperience: 9 });
    expect(after.body.infoRequests[0]).toMatchObject({ answer: 'S4–S6 mathematics.' });
    expect(after.body.infoRequests[0].answeredAt).not.toBeNull();
    expect(await p().notification.count({ where: { type: 'application.info_answered', userId: { in: admins } } })).toBe(before + admins.length);

    // Used once.
    await http().post('/api/v1/applications/info-requests/view').send({ token: token }).expect(410);
    await http().post('/api/v1/applications/info-requests/answer').send({ token: token,  answer: 'again' }).expect(410);
  });

  it('a new question replaces an unanswered one (the old link stops working); a decision cancels the open one', async () => {
    const body = teacherBody();
    const app = (await http().post(TEACHER_REGISTER).send(body).expect(201)).body.id as string;
    await http().post(`/api/v1/admin/teacher-applications/${app}/request-info`).set(bearer(admin)).send({ question: 'First question?' }).expect(200);
    const first = await tokenFor(body.email);
    await http().post(`/api/v1/admin/teacher-applications/${app}/request-info`).set(bearer(admin)).send({ question: 'Second question?' }).expect(200);
    const second = await tokenFor(body.email);
    expect(second).not.toBe(first);
    await http().post('/api/v1/applications/info-requests/view').send({ token: first }).expect(410);
    await http().post('/api/v1/applications/info-requests/view').send({ token: second }).expect(200);

    // Rejecting cancels the open question and e-mails the reason.
    await http().post(`/api/v1/admin/teacher-applications/${app}/reject`).set(bearer(admin)).send({ reason: 'School could not be confirmed.' }).expect(200);
    await http().post('/api/v1/applications/info-requests/view').send({ token: second }).expect(410);
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
    const view = await http().post('/api/v1/applications/info-requests/view').send({ token: token }).expect(200);
    expect(view.body.kind).toBe('COACH');
    await http().post('/api/v1/applications/info-requests/answer').send({ token: token,  answer: 'Here they are.', phone: 'bad' }).expect(400);
    await http().post('/api/v1/applications/info-requests/answer').send({ token: token,  answer: 'Here they are.', phone: '0788 000 222', affiliation: 'Kigali Maths Club', position: 'ignored for coaches' }).expect(200);
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
    await http().post('/api/v1/applications/info-requests/view').send({ token: token }).expect(410);
  });

  it('only administrators with the permission may ask; invalid input and unknown links are refused', async () => {
    const t = (await http().post(TEACHER_REGISTER).send(teacherBody()).expect(201)).body.id as string;
    const c = (await http().post('/api/v1/mentor-requests').send(coachBody()).expect(201)).body.id as string;
    await http().post(`/api/v1/admin/teacher-applications/${t}/request-info`).set(bearer(coach)).send({ question: 'Hello there?' }).expect(403);
    await http().post(`/api/v1/mentor-requests/${c}/request-info`).set(bearer(coach)).send({ question: 'Hello there?' }).expect(403);
    await http().post(`/api/v1/mentor-requests/${c}/request-info`).send({ question: 'Hello there?' }).expect(401);
    await http().post(`/api/v1/mentor-requests/${c}/request-info`).set(bearer(admin)).send({ question: 'Hi' }).expect(400);
    await http().post('/api/v1/admin/teacher-applications/00000000-0000-4000-8000-000000000000/request-info').set(bearer(admin)).send({ question: 'Anyone there?' }).expect(404);
    await http().post('/api/v1/applications/info-requests/view').send({ token: 'not-a-real-token-at-all-1234567890' }).expect(410);
    // A malformed token is refused before any lookup.
    await http().post('/api/v1/applications/info-requests/view').send({ token: 'short' }).expect(400);
    await http().post('/api/v1/applications/info-requests/view').send({}).expect(400);
  });

  describe('reapplication after a rejection: every attempt is its own application (final review 2026-11-18)', () => {
    const SECRETS = ['House 12 KG 5 Ave', 'What is your home address?'];
    const noSecret = (value: unknown) => { const t = JSON.stringify(value); for (const s of SECRETS) expect(t).not.toContain(s); };
    const listed = async (status: string) => (await http().get('/api/v1/mentor-requests').query({ status, limit: 100 }).set(bearer(admin)).expect(200)).body.data as any[];
    /** A coach application body (coachBody): strings, and the subjects. */
    type CoachBody = { username: string; email: string; password: string; olympiadInterests: string[]; [field: string]: string | string[] };
    let victim: CoachBody, victimId: string;

    beforeAll(async () => {
      // The first applicant is asked a private question, answers it, and is rejected.
      victim = coachBody({ firstName: 'Victoria' });
      victimId = (await http().post('/api/v1/mentor-requests').send(victim).expect(201)).body.id;
      await http().post(`/api/v1/mentor-requests/${victimId}/request-info`).set(bearer(admin)).send({ question: SECRETS[1] }).expect(200);
      await http().post('/api/v1/applications/info-requests/answer').send({ token: await tokenFor(victim.email), answer: `${SECRETS[0]}, private` }).expect(200);
      await http().patch(`/api/v1/mentor-requests/${victimId}/reject`).set(bearer(admin)).send({ reason: 'Not this year.' }).expect(200);
    });

    /** A new attempt: a new row; nothing of the victim's history in the public response, the admin list or admin answers. */
    const expectIsolated = async (body: CoachBody) => {
      const res = await http().post('/api/v1/mentor-requests').send(body).expect(201);
      expect(res.body.id).not.toBe(victimId);
      expect(res.body).not.toHaveProperty('infoRequests');
      noSecret(res.body);
      const row = (await listed('PENDING')).find((r) => r.id === res.body.id);
      expect(row).toMatchObject({ username: body.username, email: body.email, status: 'PENDING', infoRequests: [] });
      noSecret(row);
      // An Administrator's own question on the new application: its answer shape (the admin detail) has only that question.
      const asked = await http().post(`/api/v1/mentor-requests/${res.body.id}/request-info`).set(bearer(admin)).send({ question: 'Which club do you coach?' }).expect(200);
      expect(asked.body.infoRequests.map((q: any) => q.question)).toEqual(['Which club do you coach?']);
      noSecret(asked.body);
      return res.body.id as string;
    };

    it('same username, another e-mail: a new application; the earlier history is not attached to it', async () => {
      const id = await expectIsolated(coachBody({ username: victim.username }));
      await http().patch(`/api/v1/mentor-requests/${id}/reject`).set(bearer(admin)).send({}).expect(200);
    });

    it('same e-mail, another username: a new application; the earlier history is not attached to it', async () => {
      const id = await expectIsolated(coachBody({ email: victim.email }));
      await http().patch(`/api/v1/mentor-requests/${id}/reject`).set(bearer(admin)).send({}).expect(200);
    });

    it('both identifiers: a new application; while it is pending the username and e-mail are taken (generic answer)', async () => {
      const id = await expectIsolated(coachBody({ username: victim.username, email: victim.email }));
      const taken = await http().post('/api/v1/mentor-requests').send(coachBody({ username: victim.username })).expect(409);
      expect(taken.body.code).toBe('IDENTITY_TAKEN');
      expect((await http().post('/api/v1/mentor-requests').send(coachBody({ email: victim.email })).expect(409)).body.code).toBe('IDENTITY_TAKEN');
      await http().patch(`/api/v1/mentor-requests/${id}/reject`).set(bearer(admin)).send({}).expect(200);
    });

    it('the first applicant\'s attempt keeps its own details, question and answer, and is listed separately', async () => {
      const row = await p().mentorRequest.findUniqueOrThrow({ where: { id: victimId }, include: { infoRequests: true } });
      expect(row).toMatchObject({ firstName: 'Victoria', username: victim.username, email: victim.email, status: 'REJECTED', rejectionReason: 'Not this year.' });
      expect(row.infoRequests.map((q) => [q.question, q.answer])).toEqual([[SECRETS[1], `${SECRETS[0]}, private`]]);
      const rejected = await listed('REJECTED');
      expect(rejected.find((r) => r.id === victimId)?.infoRequests.map((q: any) => q.answer)).toEqual([`${SECRETS[0]}, private`]);
      // Four attempts share an identifier with the first one; the private answer belongs to exactly one of them.
      const attempts = await p().mentorRequest.findMany({ where: { OR: [{ username: victim.username }, { email: victim.email }] }, include: { infoRequests: true } });
      expect(attempts).toHaveLength(4);
      expect(attempts.filter((a) => a.infoRequests.some((q) => q.answer?.includes(SECRETS[0]))).map((a) => a.id)).toEqual([victimId]);
      expect(await p().auditLog.count({ where: { action: 'SUBMIT_MENTOR_REQUEST', metadata: { path: ['reapplication'], equals: true } } })).toBeGreaterThanOrEqual(3);
    });
  });

  it('an expired link is refused', async () => {
    const body = coachBody();
    const app = (await http().post('/api/v1/mentor-requests').send(body).expect(201)).body.id as string;
    await http().post(`/api/v1/mentor-requests/${app}/request-info`).set(bearer(admin)).send({ question: 'Still interested?' }).expect(200);
    const token = await tokenFor(body.email);
    await p().applicationInfoRequest.updateMany({ where: { mentorRequestId: app }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await http().post('/api/v1/applications/info-requests/view').send({ token: token }).expect(410);
    await http().post('/api/v1/applications/info-requests/answer').send({ token: token,  answer: 'Yes' }).expect(410);
  });
});
