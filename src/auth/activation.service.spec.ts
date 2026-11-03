import { ActivationService, ACTIVATION_TTL_MS, maskEmail } from './activation.service.js';
import { hashToken } from './token.service.js';

function makeMocks() {
  const prisma = {
    user: {
      findUnique:        vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update:            vi.fn(),
    },
    accountActivationToken: {
      create:     vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  const audit         = { log: vi.fn() };
  const notifications = { queueEmail: vi.fn() };
  const service = new ActivationService(prisma as any, audit as any, notifications as any);
  return { service, prisma, audit, notifications };
}

const user = { id: 'u1', firstName: 'Ada', email: 'ada@x.rw', username: 'ada', role: 'STUDENT', isActive: true, activatedAt: null };
const record = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', userId: 'u1', purpose: 'INVITATION', usedAt: null, revokedAt: null,
  expiresAt: new Date(Date.now() + 60_000), user, ...overrides,
});

describe('ActivationService', () => {
  describe('issue / send', () => {
    it('revokes earlier links, stores only the hash, and e-mails the raw token separately', async () => {
      const { service, prisma, notifications } = makeMocks();
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', email: 'ada@x.rw', firstName: 'Ada', activatedAt: null });

      const before = Date.now();
      const issued = await service.issue('u1', 'INVITATION', 'admin1');

      expect(prisma.accountActivationToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1', usedAt: null, revokedAt: null },
        data:  { revokedAt: expect.any(Date) },
      });
      const stored = prisma.accountActivationToken.create.mock.calls[0][0].data;
      expect(stored).toMatchObject({ userId: 'u1', purpose: 'INVITATION', createdById: 'admin1' });
      expect(stored.tokenHash).toBe(hashToken(issued.token));
      expect(stored.tokenHash).not.toBe(issued.token);
      expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before + ACTIVATION_TTL_MS.INVITATION);
      expect(notifications.queueEmail).not.toHaveBeenCalled(); // only after commit

      await service.send(issued);
      const [to, , , opts] = notifications.queueEmail.mock.calls[0];
      expect(to).toBe('ada@x.rw');
      expect(decodeURIComponent(opts.link.split('token=')[1])).toBe(issued.token);
    });

    it('refuses to issue for an account that is already active', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findUniqueOrThrow.mockResolvedValue({ id: 'u1', activatedAt: new Date() });
      await expect(service.issue('u1', 'INVITATION', null)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });
  });

  describe('activate', () => {
    it.each([
      ['unknown',  null],
      ['used',     record({ usedAt: new Date() })],
      ['revoked',  record({ revokedAt: new Date() })],
      ['expired',  record({ expiresAt: new Date(Date.now() - 1) })],
    ])('rejects a %s token with INVALID_ACTIVATION_TOKEN', async (_label, value) => {
      const { service, prisma } = makeMocks();
      prisma.accountActivationToken.findUnique.mockResolvedValue(value);
      await expect(service.activate('x'.repeat(40), 'Password123')).rejects.toMatchObject({ code: 'INVALID_ACTIVATION_TOKEN' });
    });

    it('requires a password for invitations', async () => {
      const { service, prisma } = makeMocks();
      prisma.accountActivationToken.findUnique.mockResolvedValue(record());
      await expect(service.activate('x'.repeat(40))).rejects.toMatchObject({ code: 'PASSWORD_REQUIRED' });
    });

    it('activates, sets the hashed password and audits — inside one transaction', async () => {
      const { service, prisma, audit } = makeMocks();
      prisma.accountActivationToken.findUnique.mockResolvedValue(record());

      await expect(service.activate('x'.repeat(40), 'Password123')).resolves.toMatchObject({ username: 'ada' });
      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.activatedAt).toBeInstanceOf(Date);
      expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'ACTIVATE_ACCOUNT' }), prisma);
    });

    it('e-mail verification keeps the existing password', async () => {
      const { service, prisma } = makeMocks();
      prisma.accountActivationToken.findUnique.mockResolvedValue(record({ purpose: 'EMAIL_VERIFICATION' }));
      await service.activate('x'.repeat(40));
      expect(prisma.user.update.mock.calls[0][0].data.passwordHash).toBeUndefined();
    });

    it('loses a race safely: a concurrently used token is rejected', async () => {
      const { service, prisma } = makeMocks();
      prisma.accountActivationToken.findUnique.mockResolvedValue(record());
      prisma.accountActivationToken.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.activate('x'.repeat(40), 'Password123')).rejects.toMatchObject({ code: 'INVALID_ACTIVATION_TOKEN' });
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('treats links of suspended accounts as not found', async () => {
      const { service, prisma } = makeMocks();
      prisma.accountActivationToken.findUnique.mockResolvedValue(record({ user: { ...user, isActive: false } }));
      await expect(service.inspect('x'.repeat(40))).rejects.toMatchObject({ status: 404 });
    });
  });

  it('resendForEmail answers identically whether or not the account exists', async () => {
    const { service, prisma } = makeMocks();
    prisma.user.findUnique.mockResolvedValueOnce(null);
    const a = await service.resendForEmail('nobody@x.rw');
    prisma.user.findUnique.mockResolvedValueOnce({ id: 'u1', activatedAt: new Date(), isActive: true, passwordHash: 'h' });
    const b = await service.resendForEmail('ada@x.rw');
    expect(a).toEqual(b);
  });
});

describe('maskEmail', () => {
  it.each([
    ['jean.uwase@example.com', 'j***e@example.com'],
    ['ab@x.rw', 'a@x.rw'],
    ['bad', '***'],
  ])('%s → %s', (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});
