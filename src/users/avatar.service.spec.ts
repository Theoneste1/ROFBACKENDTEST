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

  function make(opts: { user?: Record<string, unknown> | null; refuse?: boolean } = {}) {
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
    const permissions = { has: vi.fn().mockReturnValue(false) };
    const overview = { mayView: vi.fn().mockResolvedValue(true) };
    const service = new AvatarService(prisma as never, storage as never, audit as never, roles as never, users as never, permissions as never, overview as never);
    return { service, prisma, tx, storage, audit, roles, users };
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
    expect(ok.users.findOne).toHaveBeenCalledWith('stu');

    const refused = make({ user: { id: 'sa', role: 'SUPER_ADMIN', avatarFileId: null, avatarUrl: null }, refuse: true });
    await expect(refused.service.setFor('sa', ADMIN, png())).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
    await expect(refused.service.removeFor('sa', ADMIN)).rejects.toMatchObject({ code: 'ROLE_NOT_ASSIGNABLE' });
    expect(refused.roles.assertCanManage).toHaveBeenCalledWith(ADMIN, 'SUPER_ADMIN');
    expect(refused.storage.store).not.toHaveBeenCalled();
    expect(refused.tx.user.update).not.toHaveBeenCalled();
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
});
