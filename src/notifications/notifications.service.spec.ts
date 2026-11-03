import { NotificationsService } from './notifications.service.js';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `u${i}`);

function makeService() {
  const prisma = {
    notification:           { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    notificationSetting:    { findMany: vi.fn().mockResolvedValue([]) },
    notificationPreference: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findMany: vi.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(where.id.in.map((id) => ({ id, email: `${id}@x.test`, firstName: id })))),
    },
    emailDelivery: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  };
  const settings = {
    get: vi.fn().mockImplementation((key: string) =>
      Promise.resolve(key === 'notifications.emailEnabled' ? true : key === 'platform.name' ? 'ROF' : '')),
  };
  const config  = { get: vi.fn().mockReturnValue('https://lms.test') };
  const service = new NotificationsService(prisma as any, settings as any, config as any);
  return { service, prisma };
}

const payload = (type = 'assignment.published') => ({
  category: 'ASSIGNMENTS' as const, type, title: 'T', body: 'B', link: '/x',
});

describe('NotificationsService.notify', () => {
  it('writes and e-mails large audiences in chunks of at most 1000', async () => {
    const { service, prisma } = makeService();
    await service.notify(ids(2500), payload('resource.published'));

    const rows = prisma.notification.createMany.mock.calls.map((c) => c[0].data.length);
    expect(rows).toEqual([1000, 1000, 500]);
    for (const [arg] of prisma.user.findMany.mock.calls) expect(arg.where.id.in.length).toBeLessThanOrEqual(1000);
    for (const [arg] of prisma.notificationPreference.findMany.mock.calls) expect(arg.where.userId.in.length).toBeLessThanOrEqual(1000);
    expect(prisma.emailDelivery.createMany.mock.calls.reduce((n, c) => n + c[0].data.length, 0)).toBe(2500);
    // Types nobody can switch off skip the settings lookup.
    expect(prisma.notificationSetting.findMany).not.toHaveBeenCalled();
  });

  it('drops recipients who switched the type off, per channel', async () => {
    const { service, prisma } = makeService();
    prisma.notificationSetting.findMany.mockResolvedValue([
      { userId: 'u0', inAppEnabled: false, emailEnabled: false },
      { userId: 'u1', inAppEnabled: true,  emailEnabled: false },
      { userId: 'u2', inAppEnabled: false, emailEnabled: true },
    ]);
    await service.notify(['u0', 'u1', 'u2', 'u3'], payload('submissions.assigned'));

    expect(prisma.notification.createMany.mock.calls[0][0].data.map((r: { userId: string }) => r.userId)).toEqual(['u1', 'u3']);
    expect(prisma.emailDelivery.createMany.mock.calls[0][0].data.map((r: { recipientId: string }) => r.recipientId)).toEqual(['u2', 'u3']);
  });

  it('respects category e-mail opt-outs and in-app-only sends', async () => {
    const { service, prisma } = makeService();
    prisma.notificationPreference.findMany.mockResolvedValue([{ userId: 'u1' }]);
    await service.notify(['u0', 'u1'], payload());
    expect(prisma.emailDelivery.createMany.mock.calls[0][0].data.map((r: { recipientId: string }) => r.recipientId)).toEqual(['u0']);

    const inAppOnly = makeService();
    await inAppOnly.service.notify(['u0'], payload(), { email: false });
    expect(inAppOnly.prisma.notification.createMany).toHaveBeenCalledTimes(1);
    expect(inAppOnly.prisma.emailDelivery.createMany).not.toHaveBeenCalled();
  });

  it('does nothing for an empty audience', async () => {
    const { service, prisma } = makeService();
    await service.notify([], payload());
    expect(prisma.notification.createMany).not.toHaveBeenCalled();
    expect(prisma.emailDelivery.createMany).not.toHaveBeenCalled();
  });
});
