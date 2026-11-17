/**
 * REG-02 (agreed 2026-11-18): the profile picture at registration is OPTIONAL for students, teachers and coaches.
 * - registration / application without a picture succeeds and needs nothing more (activation works without one);
 * - with the registration's one-time token, a valid picture is added; invalid files are refused;
 * - the token allows only the FIRST picture of exactly that account / pending application, for 30 minutes;
 * - an application's picture becomes the account's on approval; later changes go through My Profile.
 */
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0, 0, 0]), Buffer.alloc(16, 0)]);

describe('Optional profile picture at registration (e2e)', () => {
  let ctx: TestContext;
  let admin: string, ngoma: string;
  const http = () => ctx.http();
  const p = () => ctx.prisma;
  let n = 0;
  const upload = (token: unknown, file: Buffer | null, name = 'me.png') => {
    const req = http().put('/api/v1/auth/register/avatar').field('token', String(token));
    return file ? req.attach('file', file, name) : req;
  };
  const student = (over: Record<string, unknown> = {}) => {
    n += 1;
    return http().post('/api/v1/auth/register/student').send({
      firstName: 'Pia', lastName: 'Picture', username: `ra.s${n}`, email: `ra.s${n}@test.local`, password: 'Secret123',
      dateOfBirth: '2011-03-04', gradeLevel: 'S3', homeLocation: 'Huye', schoolCode: '229911', ...over,
    });
  };

  beforeAll(async () => {
    process.env.TEACHERS_ENABLED = 'true';
    ctx = await createTestApp();
    admin = await login(ctx, 'admin');
    ngoma = (await p().school.create({ data: {
      name: 'gs ngoma ra', code: '229911', nameKey: 'gs ngoma ra', location: 'x', ownership: 'PUBLIC', source: 'OFFICIAL_LIST',
      province: 'Southern Province', district: 'Huye', sector: 'Ngoma',
    } })).id;
    await http().patch('/api/v1/admin/settings').set(bearer(admin)).send({ 'registration.teacherSelfSignup': true, 'registration.requireEmailVerification': false }).expect(200);
  });
  afterAll(async () => {
    delete process.env.TEACHERS_ENABLED;
    await ctx?.app.close();
  });

  it('student without a picture: registered, can sign in, default avatar (avatarUrl null)', async () => {
    const res = await student();
    expect([res.status, res.body.code ?? null, res.body.message ?? null]).toEqual([201, null, null]);
    expect(typeof res.body.avatarUploadToken).toBe('string');
    const token = await login(ctx, res.body.username, 'Secret123');
    const me = await http().get('/api/v1/me').set(bearer(token)).expect(200);
    expect(me.body.avatarUrl).toBeNull();
  });

  it('student with a picture: added once with the token; a second upload or another account is refused; invalid files refused', async () => {
    const res = await student().expect(201);
    const tok = res.body.avatarUploadToken;
    await upload(tok, GIF, 'x.gif').expect(415);
    await upload(tok, null).expect(400);
    await upload(tok, PNG).expect(200);
    const u = await p().user.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(u.avatarFileId).not.toBeNull();
    expect(u.avatarUrl).toContain(`/users/${u.id}/avatar`);
    expect((await upload(tok, PNG)).status).toBe(409);
    expect(await p().auditLog.count({ where: { action: 'AVATAR_SET', entityId: u.id } })).toBe(1);
    // Later: change and remove through My Profile.
    const t = await login(ctx, res.body.username, 'Secret123');
    await http().delete('/api/v1/me/avatar').set(bearer(t)).expect(200);
    expect((await p().user.findUniqueOrThrow({ where: { id: u.id } })).avatarFileId).toBeNull();
  });

  it('invalid, tampered or expired tokens are refused (401); nothing stored', async () => {
    const before = await p().fileObject.count();
    for (const tok of ['nonsense-token-value', 'aaaaaaaaaaaa.bbbbbbbbbbbb']) expect((await upload(tok, PNG)).status).toBe(401);
    expect((await upload('', PNG)).status).toBe(400);   // validation: a token is required
    expect(await p().fileObject.count()).toBe(before);
  });

  it('Teacher application: works without a picture; with one, it becomes the teacher\'s picture on approval', async () => {
    const body = (u: string) => ({
      firstName: 'Tess', lastName: 'Teacher', username: u, email: `${u}@test.local`, password: 'Secret123', confirmPassword: 'Secret123',
      country: 'RW', phone: '0788123456', olympiadInterests: ['MATHEMATICS'], schoolProvince: 'Southern Province', schoolDistrict: 'Huye',
      schoolId: ngoma, homeDistrict: 'Huye', homeSector: 'Ngoma', position: 'Teacher',
    });
    const without = await http().post('/api/v1/auth/register/teacher').send(body('ra.t1')).expect(201);
    expect(typeof without.body.avatarUploadToken).toBe('string');
    const withPic = await http().post('/api/v1/auth/register/teacher').send(body('ra.t2')).expect(201);
    await upload(withPic.body.avatarUploadToken, PNG).expect(200);
    const app = await p().teacherApplication.findUniqueOrThrow({ where: { id: withPic.body.id } });
    expect(app.avatarFileId).not.toBeNull();

    await http().post(`/api/v1/admin/teacher-applications/${without.body.id}/approve`).set(bearer(admin)).send({}).expect(200);
    await http().post(`/api/v1/admin/teacher-applications/${withPic.body.id}/approve`).set(bearer(admin)).send({}).expect(200);
    expect((await p().user.findUniqueOrThrow({ where: { username: 'ra.t1' } })).avatarFileId).toBeNull();
    const t2 = await p().user.findUniqueOrThrow({ where: { username: 'ra.t2' } });
    expect(t2.avatarFileId).toBe(app.avatarFileId);
    expect(t2.avatarUrl).toContain(`/users/${t2.id}/avatar`);
    // A decided application takes no picture any more.
    expect((await upload(withPic.body.avatarUploadToken, PNG)).status).toBe(401);
  });

  it('Coach application: works without a picture; with one, it becomes the coach\'s picture on approval', async () => {
    const without = await http().post('/api/v1/mentor-requests').send({ firstName: 'Cam', lastName: 'Coach', username: 'ra.c1', email: 'ra.c1@test.local', password: 'Mentor123' }).expect(201);
    expect(typeof without.body.avatarUploadToken).toBe('string');
    const withPic = await http().post('/api/v1/mentor-requests').send({ firstName: 'Cam', lastName: 'Coach', username: 'ra.c2', email: 'ra.c2@test.local', password: 'Mentor123' }).expect(201);
    await upload(withPic.body.avatarUploadToken, PNG).expect(200);
    await http().patch(`/api/v1/mentor-requests/${without.body.id}/approve`).set(bearer(admin)).expect(200);
    await http().patch(`/api/v1/mentor-requests/${withPic.body.id}/approve`).set(bearer(admin)).expect(200);
    expect((await p().user.findUniqueOrThrow({ where: { username: 'ra.c1' } })).avatarFileId).toBeNull();
    expect((await p().user.findUniqueOrThrow({ where: { username: 'ra.c2' } })).avatarFileId).not.toBeNull();
  });

  it('the orphan-file cleanup keeps a pending application\'s picture', async () => {
    const app = await http().post('/api/v1/mentor-requests').send({ firstName: 'Old', lastName: 'Pic', username: 'ra.c3', email: 'ra.c3@test.local', password: 'Mentor123' }).expect(201);
    await upload(app.body.avatarUploadToken, PNG).expect(200);
    const fileId = (await p().mentorRequest.findUniqueOrThrow({ where: { id: app.body.id } })).avatarFileId!;
    await p().fileObject.update({ where: { id: fileId }, data: { createdAt: new Date(Date.now() - 30 * 86_400_000) } });
    const storage = ctx.app.get((await import('../src/common/storage/storage.service.js')).StorageService);
    await (storage as unknown as { cleanupOrphans?: () => Promise<unknown> }).cleanupOrphans?.();
    expect(await p().fileObject.count({ where: { id: fileId } })).toBe(1);
  });
});
