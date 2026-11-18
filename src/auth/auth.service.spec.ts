import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service.js';
import { hashToken } from './token.service.js';

const PASSWORD = 'CorrectHorse1!';
const HASH     = bcrypt.hashSync(PASSWORD, 4);
const CLIENT   = { userAgent: 'vitest', ip: '127.0.0.1' };

function makeMocks() {
  const prisma = {
    user: {
      findFirst:  vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
      create:     vi.fn(),
      update:     vi.fn(),
      updateMany: vi.fn(),
    },
    mentorRequest:      { findFirst: vi.fn().mockResolvedValue(null) },
    teacherApplication: { findFirst: vi.fn().mockResolvedValue(null) },
    passwordResetToken: {
      create:     vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn(),
    },
    school: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    discipline:          { findMany: vi.fn().mockResolvedValue([{ id: 'd-math', code: 'MATHEMATICS' }]) },
    programmeMembership: { upsert: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  // The login lockout state of the user under test (read and written by the
  // attempt reservation under its row lock, and by the conditional lock).
  const lockState = { failedLoginCount: 0, lockedUntil: null as Date | null };
  const applyLock = (data: { failedLoginCount?: unknown; lockedUntil?: Date | null }) => {
    if (typeof data.failedLoginCount === 'number') lockState.failedLoginCount = data.failedLoginCount;
    if (data.lockedUntil !== undefined) lockState.lockedUntil = data.lockedUntil;
  };
  // Default behaviour of the user mock for the lockout fields; tests that stub
  // update/findUnique for other purposes keep this via withLockout().
  const lockoutFindUnique = (a: any) => (a?.select?.failedLoginCount ? { ...lockState } : null);
  const lockoutUpdate = (a: any) => {
    if (a?.data?.failedLoginCount?.increment) return { failedLoginCount: ++lockState.failedLoginCount };
    if (a?.data) applyLock(a.data);
    return undefined;
  };
  prisma.user.findUnique.mockImplementation(async (a: any) => lockoutFindUnique(a));
  prisma.user.update.mockImplementation(async (a: any) => lockoutUpdate(a));
  /** Make user.update answer `value` for everything except the lockout writes. */
  const withLockout = (value: unknown) =>
    prisma.user.update.mockImplementation(async (a: any) => lockoutUpdate(a) ?? value);
  const $queryRaw = vi.fn().mockResolvedValue([]);
  Object.assign(prisma, { $queryRaw });
  const tx = prisma as typeof prisma & { $queryRaw: typeof $queryRaw };
  prisma.user.updateMany.mockImplementation(async (a: any) => {
    if (!('lockedUntil' in (a?.data ?? {}))) return { count: 1 };
    if (lockState.lockedUntil && lockState.lockedUntil > new Date()) return { count: 0 };   // already locked
    applyLock(a.data);
    return { count: 1 };
  });
  // Interactive transactions run the callback against the mock; batches resolve each operation.
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: unknown) => unknown)(tx) : Promise.all(arg as unknown[]));

  const tokens = {
    issue:                vi.fn().mockResolvedValue({ access_token: 'a', refresh_token: 'r' }),
    rotate:               vi.fn(),
    revoke:               vi.fn(),
    revokeAllForUser:     vi.fn(),
    blacklistAccessToken: vi.fn(),
    verifyAccessToken:    vi.fn().mockResolvedValue(null),
  };
  const audit         = { log: vi.fn() };
  const settings      = { get: vi.fn() };
  const divisions     = { idForGrade: vi.fn().mockResolvedValue('div-junior') };
  const notifications = { queueEmail: vi.fn() };
  const academicYears = { enrollInCurrentYear: vi.fn().mockResolvedValue({ id: 'enr1' }) };
  const activity      = { record: vi.fn() };
  const issued        = { token: 't', expiresAt: new Date(), purpose: 'EMAIL_VERIFICATION', userId: 'u-new', email: 'a@x.rw', firstName: 'A' };
  const accountEmails = { welcome: vi.fn(), passwordChanged: vi.fn() };
  const events        = { emit: vi.fn() };
  /** The STUDENT_REGISTRATION form: open unless a test closes it. */
  const forms         = { assertOpen: vi.fn().mockResolvedValue(undefined) };
  const activation    = {
    issue:        vi.fn().mockResolvedValue(issued),
    send:         vi.fn().mockResolvedValue({}),
    issueAndSend: vi.fn().mockResolvedValue({}),
  };

  const service = new AuthService(
    prisma as any, tokens as any, audit as any, settings as any, divisions as any, notifications as any,
    academicYears as any, activity as any, activation as any, accountEmails as any,
    { assertCanAssign: vi.fn(), assertCanManage: vi.fn() } as any,
    { claim: vi.fn().mockResolvedValue('aff1'), supersede: vi.fn() } as any,   // school affiliation (claims are tested end to end)
    events as any,
    forms as any,
    { issue: vi.fn().mockReturnValue('avatar-token') } as any,   // registration avatar (REG-02)
  );
  return { service, prisma, tx, lockState, withLockout, tokens, audit, settings, divisions, notifications, academicYears, activity, activation, issued, accountEmails, events, forms };
}

const activeUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1', role: 'STUDENT', passwordHash: HASH, isActive: true, isApproved: true, activatedAt: new Date(), ...overrides,
});

describe('AuthService', () => {
  describe('login', () => {
    it('rejects an unknown user with 401', async () => {
      const { service, tokens } = makeMocks();
      await expect(service.login({ username: 'ghost', password: PASSWORD }, CLIENT))
        .rejects.toBeInstanceOf(UnauthorizedException);
      expect(tokens.issue).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with 401', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findFirst.mockResolvedValue(activeUser());
      await expect(service.login({ username: 'alice', password: 'wrong' }, CLIENT))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('does not reveal suspension when the password is wrong', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findFirst.mockResolvedValue(activeUser({ isActive: false }));
      await expect(service.login({ username: 'alice', password: 'wrong' }, CLIENT))
        .rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('reports ACCOUNT_SUSPENDED for an inactive user with the correct password', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findFirst.mockResolvedValue(activeUser({ isActive: false }));
      await expect(service.login({ username: 'alice', password: PASSWORD }, CLIENT))
        .rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED', status: 403 });
      expect(tokens.issue).not.toHaveBeenCalled();
    });

    it('reports ACCOUNT_PENDING_APPROVAL for an unapproved user', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findFirst.mockResolvedValue(activeUser({ isApproved: false }));
      await expect(service.login({ username: 'alice', password: PASSWORD }, CLIENT))
        .rejects.toMatchObject({ code: 'ACCOUNT_PENDING_APPROVAL' });
    });

    it('reports ACCOUNT_NOT_ACTIVATED for an unactivated account with the correct password', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findFirst.mockResolvedValue(activeUser({ activatedAt: null }));
      await expect(service.login({ username: 'alice', password: PASSWORD }, CLIENT))
        .rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVATED', status: 403 });
      expect(tokens.issue).not.toHaveBeenCalled();
    });

    it('looks up by email when the identifier contains @', async () => {
      const { service, prisma } = makeMocks();
      await expect(service.login({ username: 'a@x.rw', password: PASSWORD }, CLIENT)).rejects.toThrow();
      expect(prisma.user.findFirst.mock.calls[0][0].where).toEqual({ email: 'a@x.rw' });
    });

    it('issues tokens and returns the profile on success', async () => {
      const { service, prisma, tokens, audit, withLockout } = makeMocks();
      prisma.user.findFirst.mockResolvedValue(activeUser());
      withLockout({ id: 'u1', username: 'alice' });

      const result = await service.login({ username: 'alice', password: PASSWORD }, CLIENT);

      expect(tokens.issue).toHaveBeenCalledWith('u1', CLIENT);
      // The attempt reservation increments first; the success write sets lastLoginAt and resets the lockout.
      const success = prisma.user.update.mock.calls.find((c) => c[0].data.lastLoginAt);
      expect(success![0].data).toMatchObject({ lastLoginAt: expect.any(Date), failedLoginCount: 0, lockedUntil: null });
      expect(result).toEqual({ access_token: 'a', refresh_token: 'r', user: { id: 'u1', username: 'alice', dateOfBirthRequired: false } });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOGIN', actorId: 'u1' }));
    });

    describe('lockout (attempts are reserved before the password is checked)', () => {
      const locks = (audit: { log: ReturnType<typeof vi.fn> }) => audit.log.mock.calls.filter((c) => c[0].action === 'LOCK_ACCOUNT');

      it('the fifth wrong password locks the account once, under the user row lock', async () => {
        const { service, prisma, tx, lockState, audit } = makeMocks();
        prisma.user.findFirst.mockResolvedValue(activeUser());
        for (let i = 0; i < 4; i++) {
          await expect(service.login({ username: 'alice', password: 'wrong' }, CLIENT)).rejects.toBeInstanceOf(UnauthorizedException);
        }
        expect(lockState).toEqual({ failedLoginCount: 4, lockedUntil: null });
        await expect(service.login({ username: 'alice', password: 'wrong' }, CLIENT)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(lockState.failedLoginCount).toBe(0);
        expect(lockState.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
        expect(locks(audit)).toHaveLength(1);
        expect(locks(audit)[0][0].metadata).toEqual({ attempts: 5 });
        // Every reservation locked the row first.
        expect(tx.$queryRaw).toHaveBeenCalledTimes(5);
      });

      it('a locked account refuses the right password and counts nothing', async () => {
        const { service, prisma, lockState, tokens } = makeMocks();
        prisma.user.findFirst.mockResolvedValue(activeUser());
        lockState.lockedUntil = new Date(Date.now() + 60_000);
        await expect(service.login({ username: 'alice', password: PASSWORD }, CLIENT)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(lockState.failedLoginCount).toBe(0);
        expect(tokens.issue).not.toHaveBeenCalled();
      });

      it('with every attempt already reserved, a further attempt is refused and locks the account (no permanent stall)', async () => {
        const { service, prisma, lockState, audit, tokens } = makeMocks();
        prisma.user.findFirst.mockResolvedValue(activeUser());
        lockState.failedLoginCount = 5;   // e.g. a request died between reserving and settling
        await expect(service.login({ username: 'alice', password: PASSWORD }, CLIENT)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tokens.issue).not.toHaveBeenCalled();
        expect(lockState.failedLoginCount).toBe(0);
        expect(lockState.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
        expect(locks(audit)).toHaveLength(1);
      });

      it('the deciding wrong attempt does not lock or audit twice when a concurrent request already locked', async () => {
        const { service, prisma, lockState, audit } = makeMocks();
        prisma.user.findFirst.mockResolvedValue(activeUser());
        lockState.failedLoginCount = 4;
        // This (fifth) attempt is reserved; a concurrent request then locks the
        // account while this one's password is still being checked.
        prisma.user.update.mockImplementationOnce(async () => {
          const reserved = { failedLoginCount: ++lockState.failedLoginCount };
          lockState.lockedUntil = new Date(Date.now() + 60_000);
          return reserved;
        });
        await expect(service.login({ username: 'alice', password: 'wrong' }, CLIENT)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(lockState.failedLoginCount).toBe(5);              // the attempt was reserved
        expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);   // it tried to lock, conditionally
        expect(locks(audit)).toHaveLength(0);                      // but the account was already locked
      });

      it('a correct password on an account that cannot sign in yet does not count towards the lockout', async () => {
        const { service, prisma } = makeMocks();
        prisma.user.findFirst.mockResolvedValue(activeUser({ isActive: false }));
        await expect(service.login({ username: 'alice', password: PASSWORD }, CLIENT)).rejects.toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
        expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { failedLoginCount: 0 } });
      });

      it('an unknown user or an account without a password reserves nothing', async () => {
        const { service, prisma, tx } = makeMocks();
        await expect(service.login({ username: 'ghost', password: PASSWORD }, CLIENT)).rejects.toBeInstanceOf(UnauthorizedException);
        prisma.user.findFirst.mockResolvedValue(activeUser({ passwordHash: null }));
        await expect(service.login({ username: 'alice', password: PASSWORD }, CLIENT)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(tx.$queryRaw).not.toHaveBeenCalled();
      });
    });

    it('records a LOGIN activity on success only', async () => {
      const { service, prisma, activity, withLockout } = makeMocks();
      prisma.user.findFirst.mockResolvedValue(activeUser());
      await expect(service.login({ username: 'alice', password: 'wrong' }, CLIENT)).rejects.toThrow();
      expect(activity.record).not.toHaveBeenCalled();

      withLockout({ id: 'u1' });
      await service.login({ username: 'alice', password: PASSWORD }, CLIENT);
      expect(activity.record).toHaveBeenCalledWith('u1', 'LOGIN');
    });
  });

  describe('registerStudent', () => {
    const dto = {
      firstName: 'A', lastName: 'B', username: 'ab', email: 'ab@x.rw', password: 'Passw0rd!!',
      gradeLevel: 'S2', schoolName: 'GS Kigali', schoolLocation: 'Kigali', homeLocation: 'Gasabo',
    } as any;

    it('fails with REGISTRATION_CLOSED while the STUDENT_REGISTRATION form is closed, before writing anything', async () => {
      const { service, prisma, forms } = makeMocks();
      forms.assertOpen.mockRejectedValue(Object.assign(new Error('closed'), { code: 'REGISTRATION_CLOSED', status: 403 }));
      await expect(service.registerStudent(dto)).rejects.toMatchObject({ code: 'REGISTRATION_CLOSED', status: 403 });
      expect(forms.assertOpen).toHaveBeenCalledWith('STUDENT_REGISTRATION');
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('fails with IDENTITY_TAKEN when a pending mentor request uses the username', async () => {
      const { service, prisma, settings } = makeMocks();
      settings.get.mockResolvedValue(true);
      prisma.mentorRequest.findFirst.mockResolvedValue({ id: 'mr1' });
      await expect(service.registerStudent(dto)).rejects.toMatchObject({ code: 'IDENTITY_TAKEN', status: 409 });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('fails with IDENTITY_TAKEN when a pending teacher application uses the username or e-mail', async () => {
      const { service, prisma, settings } = makeMocks();
      settings.get.mockResolvedValue(true);
      prisma.teacherApplication.findFirst.mockResolvedValue({ id: 'ta1' });
      await expect(service.registerStudent(dto)).rejects.toMatchObject({ code: 'IDENTITY_TAKEN', status: 409 });
      expect(prisma.teacherApplication.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }) }));
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates the student and enrols them in the current academic year inside the transaction', async () => {
      const { service, prisma, settings, academicYears, audit } = makeMocks();
      settings.get.mockImplementation(async (key: string) => key === 'registration.studentSelfSignup');
      prisma.school.findMany.mockResolvedValue([{ id: 'sch1', code: '110306', name: 'GS Kigali' }]);   // the one official school with that name (P1-11)
      prisma.user.create.mockResolvedValue({ id: 'u-new', username: 'ab' });

      const result = await service.registerStudent(dto);

      expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({
        role: 'STUDENT', gradeLevel: 'S2', divisionId: 'div-junior', schoolId: 'sch1', isApproved: true,
      });
      // Verification is off: the account is active immediately.
      expect(prisma.user.create.mock.calls[0][0].data.activatedAt).toBeInstanceOf(Date);
      expect(academicYears.enrollInCurrentYear).toHaveBeenCalledWith(prisma, 'u-new', 'S2', 'sch1');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'REGISTER', entityId: 'u-new' }), prisma);
      expect(result).toEqual({ id: 'u-new', username: 'ab', requiresApproval: false, requiresEmailVerification: false, schoolVerification: 'PENDING', avatarUploadToken: 'avatar-token' });
    });

    it('with e-mail verification on: not activated, token issued in the transaction, e-mail sent after commit', async () => {
      const { service, prisma, settings, activation, issued } = makeMocks();
      settings.get.mockImplementation(async (key: string) =>
        key === 'registration.studentSelfSignup' || key === 'registration.requireEmailVerification');
      prisma.school.findMany.mockResolvedValue([{ id: 'sch1', code: '110306', name: 'GS Kigali' }]);   // the one official school with that name (P1-11)
      prisma.user.create.mockResolvedValue({ id: 'u-new', username: 'ab' });

      const result = await service.registerStudent(dto);

      expect(prisma.user.create.mock.calls[0][0].data.activatedAt).toBeNull();
      expect(activation.issue).toHaveBeenCalledWith('u-new', 'EMAIL_VERIFICATION', null, prisma);
      expect(activation.send).toHaveBeenCalledWith(issued);
      expect(result.requiresEmailVerification).toBe(true);
    });

    it('fails the registration when no academic year is current', async () => {
      const { service, prisma, settings, academicYears, audit } = makeMocks();
      settings.get.mockResolvedValue(true);
      prisma.school.findMany.mockResolvedValue([{ id: 'sch1', code: '110306', name: 'GS Kigali' }]);   // the one official school with that name (P1-11)
      prisma.user.create.mockResolvedValue({ id: 'u-new' });
      academicYears.enrollInCurrentYear.mockRejectedValue(Object.assign(new Error('none'), { code: 'NO_CURRENT_ACADEMIC_YEAR' }));

      await expect(service.registerStudent(dto)).rejects.toMatchObject({ code: 'NO_CURRENT_ACADEMIC_YEAR' });
      expect(audit.log).not.toHaveBeenCalled();
    });
  });

  describe('forgotPassword', () => {
    const GENERIC = { message: 'If an account exists for that e-mail, a reset link has been sent.' };

    it('returns the generic message and sends nothing for an unknown email', async () => {
      const { service, prisma, notifications } = makeMocks();
      await expect(service.forgotPassword('nobody@x.rw')).resolves.toEqual(GENERIC);
      expect(notifications.queueEmail).not.toHaveBeenCalled();
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
    });

    it('sends nothing for a suspended account', async () => {
      const { service, prisma, notifications } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1', firstName: 'A', email: 'a@x.rw', isActive: false, provider: 'LOCAL',
      });
      await expect(service.forgotPassword('a@x.rw')).resolves.toEqual(GENERIC);
      expect(notifications.queueEmail).not.toHaveBeenCalled();
    });

    it('sends an activation link (not a reset) to an account that was never activated', async () => {
      const { service, prisma, notifications, activation } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1', isActive: true, provider: 'LOCAL', activatedAt: null, passwordHash: null,
      });
      await expect(service.forgotPassword('a@x.rw')).resolves.toEqual(GENERIC);
      expect(activation.issueAndSend).toHaveBeenCalledWith('u1', 'INVITATION', null);
      expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
      expect(notifications.queueEmail).not.toHaveBeenCalled();
    });

    it('stores a hashed token and e-mails a link for an active local account', async () => {
      const { service, prisma, notifications } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({
        id: 'u1', isActive: true, provider: 'LOCAL', activatedAt: new Date(), passwordHash: HASH,
      });
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', firstName: 'A', email: 'a@x.rw' });

      await expect(service.forgotPassword('a@x.rw')).resolves.toEqual(GENERIC);

      expect(notifications.queueEmail).toHaveBeenCalledOnce();
      const [to, , , opts] = notifications.queueEmail.mock.calls[0];
      expect(to).toBe('a@x.rw');
      const token = decodeURIComponent((opts.link as string).split('token=')[1]);
      const stored = prisma.passwordResetToken.create.mock.calls[0][0].data;
      expect(stored.tokenHash).toBe(hashToken(token));
      // Earlier unused links stop working.
      expect(prisma.passwordResetToken.updateMany.mock.calls[0][0]).toMatchObject({ where: { userId: 'u1', usedAt: null } });
      expect(stored.tokenHash).not.toBe(token);
    });
  });

  describe('resetPassword', () => {
    it('rejects an unknown token with INVALID_RESET_TOKEN', async () => {
      const { service } = makeMocks();
      await expect(service.resetPassword('nope', 'NewPassw0rd!')).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    });

    it('rejects an expired token', async () => {
      const { service, prisma } = makeMocks();
      prisma.passwordResetToken.findUnique.mockResolvedValue({
        id: 't1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.resetPassword('tok', 'NewPassw0rd!')).rejects.toMatchObject({ code: 'INVALID_RESET_TOKEN' });
    });
  });

  describe('changePassword', () => {
    it('rejects a wrong current password with WRONG_PASSWORD', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ passwordHash: HASH, role: 'STUDENT' });
      await expect(service.changePassword('u1', 'wrong', 'NewPassw0rd!')).rejects.toMatchObject({ code: 'WRONG_PASSWORD' });
      expect(tokens.revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('changePassword: the new password and the end of every session commit together', () => {
    it('revokes all sessions inside the same transaction as the password update', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ passwordHash: HASH, role: 'STUDENT' });
      await service.changePassword('u1', PASSWORD, 'NewPassw0rd!');
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { passwordHash: expect.any(String) } });
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith('u1', prisma);   // the transaction client
    });

    it('if ending the sessions fails, the call fails (the password change is rolled back with it)', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.user.findUnique.mockResolvedValue({ passwordHash: HASH, role: 'STUDENT' });
      tokens.revokeAllForUser.mockRejectedValue(new Error('db down'));
      await expect(service.changePassword('u1', PASSWORD, 'NewPassw0rd!')).rejects.toThrow('db down');
    });
  });

  describe('resetPassword', () => {
    it('ends every session inside the transaction that sets the new password', async () => {
      const { service, prisma, tokens } = makeMocks();
      prisma.passwordResetToken.findUnique.mockResolvedValue({ id: 'r1', userId: 'u1', usedAt: null, expiresAt: new Date(Date.now() + 60_000) });
      prisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
      await service.resetPassword('token', 'NewPassw0rd!');
      expect(tokens.revokeAllForUser).toHaveBeenCalledTimes(1);
      expect(tokens.revokeAllForUser).toHaveBeenCalledWith('u1', prisma);
    });
  });

  describe('logout (H1: works without a valid access token)', () => {
    it('with only the refresh token (access token expired): revokes that session and audits its owner', async () => {
      const { service, prisma, tokens, audit } = makeMocks();
      tokens.revoke.mockResolvedValue({ userId: 'u1' });
      prisma.user.findUnique.mockResolvedValue({ role: 'STUDENT' });
      await service.logout({ refreshToken: 'refresh' });
      expect(tokens.revoke).toHaveBeenCalledWith('refresh');
      expect(tokens.blacklistAccessToken).not.toHaveBeenCalled();
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
        actorId: 'u1', actorRole: 'STUDENT', action: 'LOGOUT', entityId: 'u1',
        metadata: { sessionRevoked: true, accessTokenRevoked: false },
      }));
    });

    it('an expired or forged access token is ignored, the session is still revoked', async () => {
      const { service, tokens } = makeMocks();
      tokens.verifyAccessToken = vi.fn().mockResolvedValue(null);
      tokens.revoke.mockResolvedValue({ userId: 'u1' });
      await service.logout({ refreshToken: 'refresh', accessToken: 'expired.jwt' });
      expect(tokens.verifyAccessToken).toHaveBeenCalledWith('expired.jwt');
      expect(tokens.blacklistAccessToken).not.toHaveBeenCalled();
      expect(tokens.revoke).toHaveBeenCalledWith('refresh');
    });

    it('a still-valid access token is blacklisted as well', async () => {
      const { service, tokens } = makeMocks();
      tokens.verifyAccessToken = vi.fn().mockResolvedValue({ sub: 'u1', jti: 'j1', exp: 123 });
      tokens.revoke.mockResolvedValue({ userId: 'u1' });
      await service.logout({ refreshToken: 'refresh', accessToken: 'valid.jwt' });
      expect(tokens.blacklistAccessToken).toHaveBeenCalledWith('j1', 123);
      expect(tokens.revoke).toHaveBeenCalledWith('refresh');
    });

    it('nothing to revoke (no cookie, unknown token): succeeds silently, writes no audit entry', async () => {
      const { service, tokens, audit } = makeMocks();
      tokens.revoke.mockResolvedValue(null);
      await expect(service.logout({})).resolves.toBeUndefined();
      await expect(service.logout({ refreshToken: 'unknown' })).resolves.toBeUndefined();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });
});
