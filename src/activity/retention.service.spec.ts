import { RetentionService, RETENTION } from './retention.service.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-03T02:00:00.000Z');
const daysBefore = (days: number) => new Date(NOW.getTime() - days * DAY);

function makeMocks(workersEnabled?: string) {
  const prisma = {
    activityLog:   { deleteMany: vi.fn().mockResolvedValue({ count: 5 }) },
    notification:  { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
    emailDelivery: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
    $transaction:  vi.fn((ops: unknown[]) => Promise.all(ops)),
  };
  const config = { get: vi.fn((key: string) => (key === 'WORKERS_ENABLED' ? workersEnabled : undefined)) };
  const service = new RetentionService(prisma as any, config as any);
  return { service, prisma, config };
}

describe('RetentionService', () => {
  it('uses the documented retention periods', () => {
    expect(RETENTION).toEqual({ activityDays: 400, readNotificationDays: 180, sentEmailBodyDays: 90 });
  });

  it('run() deletes old activity and read notifications and clears old sent e-mail bodies', async () => {
    const { service, prisma } = makeMocks();

    const result = await service.run(NOW);

    expect(prisma.activityLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: daysBefore(400) } },
    });
    expect(prisma.notification.deleteMany).toHaveBeenCalledWith({
      where: { readAt: { lt: daysBefore(180) } },
    });
    expect(prisma.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: { status: 'SENT', createdAt: { lt: daysBefore(90) }, body: { not: null } },
      data:  { body: null, html: null, subject: null },
    });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(result).toEqual({ activityDeleted: 5, notificationsDeleted: 3, emailBodiesCleared: 2 });
  });

  it('nightly() does nothing when WORKERS_ENABLED=false', async () => {
    const { service, prisma } = makeMocks('false');
    const run = vi.spyOn(service, 'run');
    await service.nightly();
    expect(run).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('nightly() runs the job otherwise and never throws', async () => {
    const { service, prisma } = makeMocks();
    await service.nightly();
    expect(prisma.activityLog.deleteMany).toHaveBeenCalled();

    prisma.$transaction.mockRejectedValue(new Error('db down'));
    await expect(service.nightly()).resolves.toBeUndefined();
  });
});
