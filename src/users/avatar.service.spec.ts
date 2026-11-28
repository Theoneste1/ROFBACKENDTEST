import { FILE_RULES, MIME } from '../common/storage/file-rules.js';
import { AVATAR_CACHE_CONTROL, AvatarService, avatarUrlOf } from './avatar.service.js';

describe('profile pictures — file rule', () => {
  it('AVATAR: JPEG, PNG and WebP only, at most 2 MB, in the avatars folder', () => {
    expect([...FILE_RULES.AVATAR.allowed].sort()).toEqual([MIME.JPEG, MIME.PNG, MIME.WEBP].sort());
    expect(FILE_RULES.AVATAR.allowed.has(MIME.GIF)).toBe(false);
    expect(FILE_RULES.AVATAR.allowed.has(MIME.HEIC)).toBe(false);
    expect(FILE_RULES.AVATAR.allowed.has(MIME.PDF)).toBe(false);
    expect(FILE_RULES.AVATAR.maxBytes).toBe(2 * 1024 * 1024);
    expect(FILE_RULES.AVATAR.folder).toBe('avatars');
  });

  it('the link carries ids only and is versioned by the file id', () => {
    expect(avatarUrlOf('u-1', 'f-9')).toBe('/api/v1/users/u-1/avatar?v=f-9');
    expect(AVATAR_CACHE_CONTROL).toBe('private, max-age=86400');
  });
});

describe('AvatarService', () => {
  const STUDENT = { id: 'stu', role: 'STUDENT' };
  const ADMIN = { id: 'adm', role: 'ADMIN' };
  const png = () => ({ buffer: Buffer.from([1, 2, 3]), originalname: 'Aline Uwase - aline@school.rw.png', mimetype: 'image/png', size: 3 }) as unknown as Express.Multer.File;

  function make(opts: { user?: Record<string, unknown> | null; refuse?: boolean; profile?: boolean } = {}) {
    const user = opts.user === undefined ? { id: 'stu', role: 'STUDENT', avatarFileId: null, avatarUrl: null } : opts.user;
    const tx = {
      user: {
        findUnique: vi.fn().mockResolvedValue(user),
        findUniqueOrThrow: vi.fn().mockResolvedValue(user),
        update: vi.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue(user),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'stu', avatarUrl: 'x' }),
      },
      $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    const storage = { store: vi.fn().mockResolvedValue({ id: 'file-1', mimeType: 'image/png', size: 3 }), send: vi.fn() };
    const audit = { log: vi.fn() };
    const roles = { assertCanManage: vi.fn(async () => { if (opts.refuse) throw Object.assign(new Error('no'), { code: 'ROLE_NOT_ASSIGNABLE' }); }) };
    const users = { findOne: vi.fn().mockResolvedValue({ id: 'stu' }) };
    const permissions = { has: vi.fn().mockReturnValue(opts.profile ?? false) };
    const overview = { mayView: vi.fn().mockResolvedValue(opts.profile ?? true) };
    const service = new AvatarService(prisma as never, storage as never, audit as never, roles as never, users as never, permissions as never, overview as never);
    return { service, prisma, tx, storage, audit, roles, users, overview, permissions };
  }

  it('no file → 400 FILE_REQUIRED; nothing stored or written', async () => {
    const { service, storage, tx } = make();
    await expect(service.setOwn(STUDENT, undefined)).rejects.toMatchObject({ code: 'FILE_REQUIRED' });
    expect(storage.store).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('own picture: stored as AVATAR by the caller with the uploaded name discarded; versioned link; audit holds ids only', async () => {
    const { service, storage, tx, audit } = make();
    await service.setOwn(STUDENT, png());
    expect(storage.store).toHaveBeenCalledWith(expect.objectContaining({ originalname: '' }), 'AVATAR', 'stu');
    expect(tx.user.update).toHaveBeenCalledWith({ where: { id: 'stu' }, data: { avatarFileId: 'file-1', avatarUrl: '/api/v1/users/stu/avatar?v=file-1' } });
    const entry = audit.log.mock.calls[0][0];
    expect(entry).toMatchObject({ actorId: 'stu', action: 'AVATAR_SET', entity: 'User', entityId: 'stu', metadata: { fileId: 'file-1', previousFileId: null } });
    expect(Object.keys(entry.metadata).sort()).toEqual(['fileId', 'previousFileId']);
    expect(JSON.stringify(entry)).not.toMatch(/aline|school\.rw/i);
  });

  it('removing: idempotent — no picture, nothing written or audited; with one, both cleared and audited', async () => {
    const none = make();
    await none.service.removeOwn(STUDENT);
    expect(none.tx.user.update).not.toHaveBeenCalled();
    expect(none.audit.log).not.toHaveBeenCalled();

    const some = make({ user: { id: 'stu', role: 'STUDENT', avatarFileId: 'file-1', avatarUrl: '/api/v1/users/stu/avatar?v=file-1' } });
    await some.service.removeOwn(STUDENT);
    expect(some.tx.user.update).toHaveBeenCalledWith({ where: { id: 'stu' }, data: { avatarFileId: null, avatarUrl: null } });
    expect(some.audit.log.mock.calls[0][0]).toMatchObject({ action: 'AVATAR_REMOVED', metadata: { fileId: 'file-1' } });
  });

  it('another account: the role policy decides on the target\'s current role; a refusal stores and writes nothing', async () => {
    const ok = make();
    await ok.service.setFor('stu', ADMIN, png());
    expect(ok.roles.assertCanManage).toHaveBeenCalledWith(ADMIN, 'STUDENT');
    expect(ok.users.findOne).toHaveBeenCalledWith('stu', ADMIN);

    const refused = make({ user: { id: 'adm2', role: 'ADMIN', avatarFileId: null, avatarUrl: null }, refuse: true });
    await expect(refused.service.setFor('adm2', ADMIN, png())).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
    await expect(refused.service.removeFor('adm2', ADMIN)).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
    expect(refused.roles.assertCanManage).toHaveBeenCalledWith(ADMIN, 'ADMIN');
    expect(refused.storage.store).not.toHaveBeenCalled();
    expect(refused.tx.user.update).not.toHaveBeenCalled();
  });

  // Super Administrator privacy (owner 2026-11-28; this replaces "an ADMIN gets 403 ROLE_NOT_ASSIGNABLE for a SUPER_ADMIN"):
  // for anyone else a Super Administrator does not exist — the same 404 as an unknown id, before any other check.
  it('a Super Administrator target: 404 "User … not found." for an ADMIN (as for an unknown id); nothing stored or written', async () => {
    const sa = make({ user: { id: 'sa', role: 'SUPER_ADMIN', avatarFileId: 'f', avatarUrl: 'x' } });
    const unknown = make({ user: null });
    for (const m of [sa, unknown]) {
      const id = m === sa ? 'sa' : 'nobody';
      await expect(m.service.setFor(id, ADMIN, png())).rejects.toThrow(`User ${id} not found.`);
      await expect(m.service.removeFor(id, ADMIN)).rejects.toThrow(`User ${id} not found.`);
      expect(m.roles.assertCanManage).not.toHaveBeenCalled();
      expect(m.storage.store).not.toHaveBeenCalled();
      expect(m.tx.user.update).not.toHaveBeenCalled();
    }
    // A Super Administrator manages another one (the policy decides).
    const bySa = make({ user: { id: 'sa', role: 'SUPER_ADMIN', avatarFileId: null, avatarUrl: null } });
    await bySa.service.setFor('sa', { id: 'sa2', role: 'SUPER_ADMIN' }, png());
    expect(bySa.roles.assertCanManage).toHaveBeenCalledWith({ id: 'sa2', role: 'SUPER_ADMIN' }, 'SUPER_ADMIN');
  });

  it('serving a Super Administrator\'s picture: Super Administrators only; anyone else gets the "no picture" 404', async () => {
    const file = { storageKey: 'avatars/2026/11/s.png', mimeType: 'image/png', originalName: 'file.png', size: 3 };
    for (const role of ['ADMIN', 'HEAD_COACH', 'MENTOR', 'TEACHER', 'STUDENT', 'UNKNOWN_ROLE']) {
      const m = make({ user: { role: 'SUPER_ADMIN', avatarFile: file } });
      await expect(m.service.send('sa', { id: 'v', role } as never, {} as never)).rejects.toThrow(/no profile picture/);
      expect(m.storage.send).not.toHaveBeenCalled();
    }
    const m = make({ user: { role: 'SUPER_ADMIN', avatarFile: file } });
    await m.service.send('sa', { id: 'sa2', role: 'SUPER_ADMIN' } as never, {} as never);
    // Never kept in a browser cache: a shared computer's next user must not see it without the server's check.
    expect(m.storage.send).toHaveBeenCalledWith({}, file, { cacheControl: 'private, no-store' });
  });

  it('serving: 404 without a picture; otherwise the file with the versioned cache header', async () => {
    const none = make({ user: { avatarFile: null } });
    const viewer = { id: 'viewer', role: 'ADMIN' } as never;
    await expect(none.service.send('stu', viewer, {} as never)).rejects.toThrow(/no profile picture/);
    const file = { storageKey: 'avatars/2026/11/u.png', mimeType: 'image/png', originalName: 'file.png', size: 3 };
    const some = make({ user: { avatarFile: file } });
    await some.service.send('stu', viewer, {} as never);
    expect(some.storage.send).toHaveBeenCalledWith({}, file, { cacheControl: 'private, max-age=86400' });
  });

  // Owner 2026-11-27: any signed-in user who may view a person's profile sees the picture — by exactly the profile's check.
  describe("serving: the picture follows the profile's own check (students, Coaches, Head Coaches)", () => {
    const file = { storageKey: 'avatars/2026/11/u.png', mimeType: 'image/png', originalName: 'file.png', size: 3 };
    const viewer = { id: 'viewer', role: 'STUDENT', divisionId: 'd1' } as never;
    const NO_PICTURE = 'This account has no profile picture.';

    it('a student: StudentOverviewService.mayView (the check of GET /students/:id/overview) decides; allowed → never cached', async () => {
      const m = make({ user: { id: 'u', role: 'STUDENT', accountStatus: 'ACTIVE', divisionId: 'd1', avatarFile: file }, profile: true });
      await m.service.send('u', viewer, {} as never);
      expect(m.overview.mayView).toHaveBeenCalledTimes(1);
      expect(m.permissions.has).not.toHaveBeenCalled();
      expect(m.storage.send).toHaveBeenCalledWith({}, file, { cacheControl: 'private, no-store' });
    });

    it.each(['MENTOR', 'HEAD_COACH'])('a %s: users.manage (the permission of GET /admin/users/:id) decides; allowed → never cached', async (role) => {
      const m = make({ user: { id: 'u', role, accountStatus: 'ACTIVE', divisionId: null, avatarFile: file }, profile: true });
      await m.service.send('u', viewer, {} as never);
      expect(m.permissions.has).toHaveBeenCalledWith(viewer, 'users.manage');
      expect(m.overview.mayView).not.toHaveBeenCalled();
      expect(m.storage.send).toHaveBeenCalledWith({}, file, { cacheControl: 'private, no-store' });
    });

    it.each(['MENTOR', 'HEAD_COACH'])('a %s sees their own picture (their own profile, GET /me) without users.manage', async (role) => {
      const m = make({ user: { id: 'viewer', role, accountStatus: 'ACTIVE', divisionId: null, avatarFile: file }, profile: false });
      await m.service.send('viewer', { id: 'viewer', role } as never, {} as never);
      expect(m.storage.send).toHaveBeenCalledTimes(1);
    });

    it.each(['STUDENT', 'MENTOR', 'HEAD_COACH'])('a %s: refused → the same 404 with or without a picture; nothing sent', async (role) => {
      const withPicture = make({ user: { id: 'u', role, accountStatus: 'ACTIVE', divisionId: 'd2', avatarFile: file }, profile: false });
      const without = make({ user: { id: 'u', role, accountStatus: 'ACTIVE', divisionId: 'd2', avatarFile: null }, profile: false });
      const a = await withPicture.service.send('u', viewer, {} as never).catch((e: Error) => e.message);
      const b = await without.service.send('u', viewer, {} as never).catch((e: Error) => e.message);
      expect([a, b]).toEqual([NO_PICTURE, NO_PICTURE]);
      expect(withPicture.storage.send).not.toHaveBeenCalled();
    });

    it('an unknown account: the same 404, no check asked', async () => {
      const m = make({ user: null });
      await expect(m.service.send('nobody', viewer, {} as never)).rejects.toThrow(NO_PICTURE);
      expect(m.overview.mayView).not.toHaveBeenCalled();
      expect(m.permissions.has).not.toHaveBeenCalled();
    });

    it.each(['TEACHER', 'ADMIN'])('another account (%s): every signed-in user, cached for a day; no check asked', async (role) => {
      const m = make({ user: { id: 't', role, accountStatus: 'ACTIVE', divisionId: null, avatarFile: file }, profile: false });
      await m.service.send('t', viewer, {} as never);
      expect(m.overview.mayView).not.toHaveBeenCalled();
      expect(m.permissions.has).not.toHaveBeenCalled();
      expect(m.storage.send).toHaveBeenCalledWith({}, file, { cacheControl: 'private, max-age=86400' });
    });
  });
});
