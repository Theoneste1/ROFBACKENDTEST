/**
 * Profile pictures (capability profilePictures): upload, replace, remove, view; administrators on other
 * accounts (users.manage + the role policy, including SUPER_ADMIN_BOUNDARY_ENABLED); protections for minors
 * (never public, ids-only links, random storage keys, no uploaded file names, ids-only audit); orphan cleanup.
 * Runs on its own freshly reset test database (never production).
 */
import { StorageService } from '../src/common/storage/storage.service.js';
import { createTestApp, login, bearer, type TestContext } from './helpers.js';

// A real 1×1 PNG and the headers of a JPEG, a WebP and a GIF (the type is detected from the bytes).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'), Buffer.alloc(64, 0), Buffer.from([0xff, 0xd9])]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(32, 0)]);
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([1, 0, 1, 0, 0, 0, 0]), Buffer.alloc(16, 0)]);

describe('profile pictures', () => {
  let ctx: TestContext;
  let student: string;
  let student2: string;
  let admin: string;
  const p = () => ctx.prisma;
  const http = () => ctx.http();
  const put = (path: string, token: string, data: Buffer, name = 'photo.png') => http().put(path).set(bearer(token)).attach('file', data, name);
  const codeOf = async (req: any) => { const r = await req; return [r.status, r.body?.code ?? null]; };
  const userRow = (id: string) => p().user.findUniqueOrThrow({ where: { id }, select: { avatarUrl: true, avatarFileId: true, username: true, email: true } });

  beforeAll(async () => {
    delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
    ctx = await createTestApp();
    student = await login(ctx, 'student.j');
    student2 = await login(ctx, 'student.s');
    admin = await login(ctx, 'admin');
  });
  afterEach(() => { delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED; });
  afterAll(async () => { await ctx?.app.close(); });

  it('the capability is advertised', async () => {
    const r = await http().get('/api/v1').expect(200);
    expect(r.body.capabilities.features).toContain('profilePictures');
  });

  describe('own picture (/me/avatar)', () => {
    it('PUT a PNG: the response is the full GET /me profile with a versioned, ids-only avatarUrl', async () => {
      const r = await put('/api/v1/me/avatar', student, PNG).expect(200);
      const me = await http().get('/api/v1/me').set(bearer(student)).expect(200);
      expect(Object.keys(r.body).sort()).toEqual(Object.keys(me.body).sort());
      expect(r.body).toEqual(me.body);
      const row = await userRow(ctx.ids.studentJunior);
      expect(r.body.avatarUrl).toBe(`/api/v1/users/${ctx.ids.studentJunior}/avatar?v=${row.avatarFileId}`);
      expect(r.body.avatarUrl).not.toContain(row.username);
      expect(r.body.avatarUrl).not.toContain(row.email);
    });

    it('the stored file has a random key in avatars/, a generic name (the uploaded name is discarded) and the detected type', async () => {
      const row = await userRow(ctx.ids.studentJunior);
      const file = await p().fileObject.findUniqueOrThrow({ where: { id: row.avatarFileId! } });
      expect(file.purpose).toBe('AVATAR');
      expect(file.storageKey).toMatch(/^avatars\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
      for (const personal of [row.username, row.email, 'student', 'photo']) {
        expect(file.storageKey.toLowerCase()).not.toContain(personal.toLowerCase());
        expect(file.originalName.toLowerCase()).not.toContain(personal.toLowerCase());
      }
      expect(file.originalName).toBe('file.png');
      expect(file.mimeType).toBe('image/png');
    });

    it('replacing (JPEG, then WebP) changes the version every time; the old file is no longer referenced', async () => {
      const first = (await userRow(ctx.ids.studentJunior)).avatarUrl;
      const firstFile = (await userRow(ctx.ids.studentJunior)).avatarFileId!;
      const r1 = await put('/api/v1/me/avatar', student, JPEG, 'Aline Uwase.jpg').expect(200);
      expect(r1.body.avatarUrl).not.toBe(first);
      const r2 = await put('/api/v1/me/avatar', student, WEBP, 'x.webp').expect(200);
      expect(r2.body.avatarUrl).not.toBe(r1.body.avatarUrl);
      expect((await p().fileObject.findUniqueOrThrow({ where: { id: (await userRow(ctx.ids.studentJunior)).avatarFileId! } })).mimeType).toBe('image/webp');
      expect(await p().user.count({ where: { avatarFileId: firstFile } })).toBe(0);
    });

    it('refuses a GIF, a text file renamed .png, an empty file, a missing file and an over-size file — nothing changes', async () => {
      const before = await userRow(ctx.ids.studentJunior);
      const files = await p().fileObject.count();
      expect(await codeOf(put('/api/v1/me/avatar', student, GIF, 'a.gif'))).toEqual([415, 'FILE_TYPE_NOT_ALLOWED']);
      expect(await codeOf(put('/api/v1/me/avatar', student, Buffer.from('just some text, not an image'), 'evil.png'))).toEqual([415, 'FILE_TYPE_NOT_ALLOWED']);
      expect(await codeOf(http().put('/api/v1/me/avatar').set(bearer(student)).field('x', '1'))).toEqual([400, 'FILE_REQUIRED']);
      const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 + 1, 0)]);
      expect(await codeOf(put('/api/v1/me/avatar', student, big, 'big.png'))).toEqual([413, 'PAYLOAD_TOO_LARGE']);   // the upload pipeline's per-file cap (multer, 2 MB)
      expect(await userRow(ctx.ids.studentJunior)).toEqual(before);
      expect(await p().fileObject.count()).toBe(files);
    });

    it('DELETE clears the picture and returns the profile; a second DELETE changes nothing (idempotent)', async () => {
      const r = await http().delete('/api/v1/me/avatar').set(bearer(student)).expect(200);
      const me = await http().get('/api/v1/me').set(bearer(student)).expect(200);
      expect(r.body).toEqual(me.body);
      expect(r.body.avatarUrl).toBeNull();
      expect((await userRow(ctx.ids.studentJunior)).avatarFileId).toBeNull();
      const audits = await p().auditLog.count({ where: { action: 'AVATAR_REMOVED' } });
      await http().delete('/api/v1/me/avatar').set(bearer(student)).expect(200);
      expect(await p().auditLog.count({ where: { action: 'AVATAR_REMOVED' } })).toBe(audits);
      await http().get(`/api/v1/users/${ctx.ids.studentJunior}/avatar`).set(bearer(student2)).expect(404);
    });
  });

  describe('viewing (GET /users/:id/avatar)', () => {
    it('an Administrator sees the picture of a student inline, never cached, nosniff; another student cannot (2026-11-18); anonymous is 401; no picture is 404', async () => {
      await put('/api/v1/me/avatar', student, PNG).expect(200);
      // A student's picture: the student, Administrators and teachers who may view the profile only.
      await http().get(`/api/v1/users/${ctx.ids.studentJunior}/avatar`).set(bearer(student2)).expect(404);
      const r = await http().get(`/api/v1/users/${ctx.ids.studentJunior}/avatar`).set(bearer(admin)).buffer(true)
        .parse((res, cb) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); })
        .expect(200);
      expect(r.headers['content-type']).toBe('image/png');
      expect(r.headers['cache-control']).toBe('private, no-store');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-disposition']).toMatch(/^inline/);
      expect(r.headers['content-disposition']).not.toMatch(/student|photo/i);
      expect(Buffer.compare(r.body as Buffer, PNG)).toBe(0);
      await http().get(`/api/v1/users/${ctx.ids.studentJunior}/avatar`).expect(401);
      await http().get(`/api/v1/users/${ctx.ids.studentJunior}/avatar?v=anything`).expect(401);
      await http().get(`/api/v1/users/${ctx.ids.studentSenior}/avatar`).set(bearer(student)).expect(404);
      await http().put('/api/v1/me/avatar').attach('file', PNG, 'a.png').expect(401);
      await http().delete('/api/v1/me/avatar').expect(401);
    });
  });

  describe('other accounts (Administrators)', () => {
    it('a student or coach cannot set or remove someone else\'s picture (only /me exists for them)', async () => {
      const coach = await login(ctx, 'mentor.j');
      const before = await userRow(ctx.ids.studentJunior);
      expect(await codeOf(put(`/api/v1/admin/users/${ctx.ids.studentJunior}/avatar`, student2, PNG))).toEqual([403, expect.any(String)]);
      expect(await codeOf(http().delete(`/api/v1/admin/users/${ctx.ids.studentJunior}/avatar`).set(bearer(coach)))).toEqual([403, expect.any(String)]);
      expect(await userRow(ctx.ids.studentJunior)).toEqual(before);
    });

    it('an ADMIN sets and removes a student\'s picture: account returned, audited with ids only', async () => {
      const r = await put(`/api/v1/admin/users/${ctx.ids.studentSenior}/avatar`, admin, PNG).expect(200);
      expect(r.body.id).toBe(ctx.ids.studentSenior);
      expect(r.body.avatarUrl).toMatch(new RegExp(`^/api/v1/users/${ctx.ids.studentSenior}/avatar\\?v=`));
      const set = await p().auditLog.findFirstOrThrow({ where: { action: 'AVATAR_SET', entityId: ctx.ids.studentSenior } });
      expect(set).toMatchObject({ actorId: ctx.ids.admin, actorRole: 'ADMIN', entity: 'User' });
      expect(Object.keys(set.metadata as object).sort()).toEqual(['fileId', 'previousFileId']);
      await http().delete(`/api/v1/admin/users/${ctx.ids.studentSenior}/avatar`).set(bearer(admin)).expect(200);
      const removed = await p().auditLog.findFirstOrThrow({ where: { action: 'AVATAR_REMOVED', entityId: ctx.ids.studentSenior } });
      expect(removed).toMatchObject({ actorId: ctx.ids.admin });
      expect(Object.keys(removed.metadata as object)).toEqual(['fileId']);
      // Own changes are audited too, also with ids only.
      const own = await p().auditLog.findFirstOrThrow({ where: { action: 'AVATAR_SET', entityId: ctx.ids.studentJunior } });
      expect(own.actorId).toBe(ctx.ids.studentJunior);
      // Metadata holds ids only (the audit row's actor columns name the actor, as for every audited action).
      const metadata = (await p().auditLog.findMany({ where: { action: { in: ['AVATAR_SET', 'AVATAR_REMOVED'] } } })).map((a) => a.metadata);
      expect(metadata.length).toBeGreaterThan(0);
      expect(JSON.stringify(metadata)).not.toMatch(/@test\.local|student|photo|\.png|image\//);
    });

    it('an ADMIN cannot touch a SUPER_ADMIN\'s picture; a SUPER_ADMIN can', async () => {
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const sa = await p().user.create({ data: { username: 'pic.sa', firstName: 'S', lastName: 'A', email: 'pic.sa@test.local', role: 'SUPER_ADMIN', passwordHash: hash, activatedAt: new Date() } });
      expect(await codeOf(put(`/api/v1/admin/users/${sa.id}/avatar`, admin, PNG))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      expect(await codeOf(http().delete(`/api/v1/admin/users/${sa.id}/avatar`).set(bearer(admin)))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      expect((await userRow(sa.id)).avatarFileId).toBeNull();
      const saToken = await login(ctx, 'pic.sa');
      await put(`/api/v1/admin/users/${ctx.ids.studentJunior2}/avatar`, saToken, PNG).expect(200);
    });

    it('SUPER_ADMIN_BOUNDARY_ENABLED on (with an active Super Admin): an ADMIN cannot manage another ADMIN\'s picture; off again, it can', async () => {
      const hash = (await p().user.findUniqueOrThrow({ where: { id: ctx.ids.admin } })).passwordHash;
      const other = await p().user.create({ data: { username: 'pic.admin2', firstName: 'O', lastName: 'A', email: 'pic.admin2@test.local', role: 'ADMIN', passwordHash: hash, activatedAt: new Date() } });
      process.env.SUPER_ADMIN_BOUNDARY_ENABLED = 'true';
      expect(await codeOf(put(`/api/v1/admin/users/${other.id}/avatar`, admin, PNG))).toEqual([403, 'ROLE_NOT_ASSIGNABLE']);
      expect((await userRow(other.id)).avatarFileId).toBeNull();
      // Students are unaffected by the boundary.
      await put(`/api/v1/admin/users/${ctx.ids.studentSenior}/avatar`, admin, PNG).expect(200);
      delete process.env.SUPER_ADMIN_BOUNDARY_ENABLED;
      await put(`/api/v1/admin/users/${other.id}/avatar`, admin, PNG).expect(200);
    });
  });

  it('the nightly orphan cleanup keeps every current picture and removes replaced ones', async () => {
    const current = (await userRow(ctx.ids.studentJunior)).avatarFileId!;
    await put('/api/v1/me/avatar', student, PNG).expect(200);
    const replaced = current;
    const now = (await userRow(ctx.ids.studentJunior)).avatarFileId!;
    await p().fileObject.updateMany({ data: { createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) } });
    await ctx.app.get(StorageService).cleanupOrphans();
    expect(await p().fileObject.findUnique({ where: { id: replaced } })).toBeNull();
    expect(await p().fileObject.findUnique({ where: { id: now } })).not.toBeNull();
    for (const u of await p().user.findMany({ where: { avatarFileId: { not: null } }, select: { avatarFileId: true } })) {
      expect(await p().fileObject.findUnique({ where: { id: u.avatarFileId! } })).not.toBeNull();
    }
    await http().get(`/api/v1/users/${ctx.ids.studentJunior}/avatar`).set(bearer(student)).expect(200);
  });
});
