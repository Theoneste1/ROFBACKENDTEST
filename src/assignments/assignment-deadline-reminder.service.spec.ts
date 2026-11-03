import { AssignmentDeadlineReminderService } from './assignment-deadline-reminder.service.js';
import { Events } from '../notifications/events.js';

function make({ workers = 'true', enabled = true, hours = 24, claimed = [{ id: 'a1' }, { id: 'a2' }] } = {}) {
  const prisma   = { $queryRaw: vi.fn().mockResolvedValue(claimed) };
  const config   = { get: vi.fn().mockImplementation((k: string) => (k === 'WORKERS_ENABLED' ? workers : undefined)) };
  const events   = { emit: vi.fn() };
  const settings = {
    get: vi.fn().mockImplementation((k: string) =>
      Promise.resolve(k === 'notifications.deadlineRemindersEnabled' ? enabled : hours)),
  };
  const service = new AssignmentDeadlineReminderService(prisma as any, config as any, events as any, settings as any);
  return { service, prisma, events };
}

describe('AssignmentDeadlineReminderService', () => {
  it('emits one event per assignment it claims', async () => {
    const { service, events } = make();
    await expect(service.sendDue()).resolves.toBe(2);
    expect(events.emit.mock.calls).toEqual([
      [Events.AssignmentDeadlineApproaching, { assignmentId: 'a1' }],
      [Events.AssignmentDeadlineApproaching, { assignmentId: 'a2' }],
    ]);
  });

  it('uses the reminder window from the settings', async () => {
    const { service, prisma } = make({ hours: 48 });
    const now = new Date('2026-11-03T10:00:00Z');
    await service.sendDue(now);
    const params = prisma.$queryRaw.mock.calls[0].slice(1) as unknown[];
    expect(params).toContainEqual(now);
    expect(params).toContainEqual(new Date('2026-11-05T10:00:00Z'));
  });

  it('does nothing when reminders are switched off', async () => {
    const { service, prisma } = make({ enabled: false });
    await expect(service.sendDue()).resolves.toBe(0);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('the scheduled run is skipped on instances without workers', async () => {
    const { service, prisma } = make({ workers: 'false' });
    await service.run();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('the scheduled run never throws: a failure is logged', async () => {
    const { service, prisma } = make();
    prisma.$queryRaw.mockRejectedValue(new Error('connection lost'));
    const log = vi.spyOn((service as any).logger, 'error').mockImplementation(() => undefined);
    await expect(service.run()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connection lost'));
  });
});
