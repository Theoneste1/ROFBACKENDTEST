import { NotFoundException } from '@nestjs/common';
import { MentorRequestsService } from './mentor-requests.service.js';
import { Events } from '../notifications/events.js';

const ADMIN = { id: 'a1', role: 'ADMIN' };

const dto = {
  firstName: 'Jean', lastName: 'Mugabo', username: 'jean', email: 'jean@x.rw', password: 'Passw0rd!!',
} as any;

const pending = (overrides: Record<string, unknown> = {}) => ({
  id: 'mr1', firstName: 'Jean', lastName: 'Mugabo', username: 'jean', email: 'jean@x.rw',
  passwordHash: 'hash', status: 'PENDING', ...overrides,
});

function makeMocks() {
  const prisma = {
    user: {
      findFirst: vi.fn().mockResolvedValue(null),
      create:    vi.fn().mockResolvedValue({ id: 'u-new', username: 'jean', role: 'MENTOR', email: 'jean@x.rw' }),
    },
    mentorRequest: {
      findFirst:  vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(pending()),
      create:     vi.fn().mockResolvedValue({ id: 'mr-new', updatedAt: new Date('2026-11-14T10:00:00.000Z') }),
      update:     vi.fn().mockResolvedValue({ id: 'mr-old', updatedAt: new Date('2026-11-14T10:00:00.000Z') }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    teacherApplication:  { findFirst: vi.fn().mockResolvedValue(null) },
    discipline:          { findMany: vi.fn().mockResolvedValue([{ id: 'd-math', code: 'MATHEMATICS' }]) },
    programmeMembership: { upsert: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));

  const audit  = { log: vi.fn() };
  const events = { emit: vi.fn() };
  const activation = {
    issue: vi.fn().mockResolvedValue({ token: 't', userId: 'u-new', purpose: 'EMAIL_VERIFICATION' }),
    send:  vi.fn().mockResolvedValue(undefined),
  };
  const settings = { get: vi.fn().mockResolvedValue(false) }; // e-mail verification off
  const notices = { enqueue: vi.fn().mockResolvedValue('outbox-1'), dispatchAfterCommit: vi.fn() };
  const forms = { assertOpen: vi.fn().mockResolvedValue(undefined) };   // the COACH_APPLICATION form is open
  const infoRequests = { cancelOpen: vi.fn().mockResolvedValue(undefined), request: vi.fn() };
  const service = new MentorRequestsService(prisma as any, audit as any, events as any, activation as any, settings as any, notices as any, forms as any, infoRequests as any);
  return { service, prisma, audit, events, activation, settings, notices, forms };
}

describe('MentorRequestsService', () => {
  describe('create', () => {
    it('rejects an identity used by an existing user', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      await expect(service.create(dto)).rejects.toMatchObject({ code: 'IDENTITY_TAKEN', status: 409 });
      expect(prisma.mentorRequest.create).not.toHaveBeenCalled();
    });

    it('rejects an identity held by a pending teacher application', async () => {
      const { service, prisma } = makeMocks();
      prisma.teacherApplication.findFirst.mockResolvedValue({ id: 'ta1' });
      await expect(service.create(dto)).rejects.toMatchObject({ code: 'IDENTITY_TAKEN', status: 409 });
      expect(prisma.teacherApplication.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'PENDING' }) }));
      expect(prisma.mentorRequest.create).not.toHaveBeenCalled();
    });

    it('rejects an identity used by a pending request', async () => {
      const { service, prisma } = makeMocks();
      prisma.mentorRequest.findFirst.mockResolvedValue(pending());
      await expect(service.create(dto)).rejects.toMatchObject({ code: 'IDENTITY_TAKEN' });
    });

    it('creates a new PENDING request with a hashed password', async () => {
      const { service, prisma, audit } = makeMocks();
      await service.create(dto);
      const data = prisma.mentorRequest.create.mock.calls[0][0].data;
      expect(data.status).toBe('PENDING');
      expect(data.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(data.passwordHash).not.toBe(dto.password);
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ metadata: { reapplication: false } }));
    });

    it('stores the application details (coachApplicationDetails); older clients get NULL / no interests', async () => {
      const { service, prisma } = makeMocks();
      await service.create({ ...dto, country: 'KE', occupation: 'Teacher', educationLevel: 'MASTER', olympiadInterests: ['PHYSICS', 'MATHEMATICS'] });
      expect(prisma.mentorRequest.create.mock.calls[0][0].data).toMatchObject({
        country: 'KE', occupation: 'Teacher', educationLevel: 'MASTER', olympiadInterests: ['MATHEMATICS', 'PHYSICS'], status: 'PENDING',
      });
      await service.create(dto);
      expect(prisma.mentorRequest.create.mock.calls[1][0].data).toMatchObject({ country: null, occupation: null, educationLevel: null, olympiadInterests: [] });
    });

    it('tells administrators about the application (one event per submission)', async () => {
      const { service, events } = makeMocks();
      await service.create(dto);
      expect(events.emit).toHaveBeenCalledWith(Events.MentorRequestSubmitted, {
        requestId: 'mr-new', submittedAt: '2026-11-14T10:00:00.000Z', reapplication: false,
      });
    });

    it('reuses a previously REJECTED request instead of creating a new one', async () => {
      const { service, prisma, audit, events } = makeMocks();
      prisma.mentorRequest.findFirst.mockResolvedValue(pending({ id: 'mr-old', status: 'REJECTED' }));

      await service.create(dto);

      expect(prisma.mentorRequest.create).not.toHaveBeenCalled();
      expect(prisma.mentorRequest.update).toHaveBeenCalledOnce();
      const call = prisma.mentorRequest.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'mr-old' });
      expect(call.data.status).toBe('PENDING');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ metadata: { reapplication: true } }));
      expect(events.emit).toHaveBeenCalledWith(Events.MentorRequestSubmitted, expect.objectContaining({ requestId: 'mr-old', reapplication: true }));
    });
  });

  describe('approve', () => {
    it('returns 404 for an unknown request', async () => {
      const { service, prisma } = makeMocks();
      prisma.mentorRequest.findUnique.mockResolvedValue(null);
      await expect(service.approve('nope', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails with INVALID_STATE_TRANSITION when the request was already processed', async () => {
      const { service, prisma, events, notices } = makeMocks();
      prisma.mentorRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approve('mr1', ADMIN)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', status: 409 });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
      expect(notices.enqueue).not.toHaveBeenCalled();
      expect(notices.dispatchAfterCommit).not.toHaveBeenCalled();
    });

    it('fails with IDENTITY_TAKEN when a user grabbed the identity meanwhile', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      await expect(service.approve('mr1', ADMIN)).rejects.toMatchObject({ code: 'IDENTITY_TAKEN' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates a MENTOR account with the stored hash, clears it from the request and queues ONE approval notice', async () => {
      const { service, prisma, events, notices } = makeMocks();

      const result = await service.approve('mr1', ADMIN);

      expect(prisma.mentorRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr1', status: 'PENDING' },
        data:  { status: 'APPROVED', passwordHash: null },
      });
      expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({ role: 'MENTOR', passwordHash: 'hash' });
      expect(result.request).toEqual({ id: 'mr1', status: 'APPROVED' });
      // The approval notice goes through the decision-notification outbox, inside the transaction —
      // the former MentorRequestDecided approval e-mail is no longer emitted (never two approval e-mails).
      expect(events.emit).not.toHaveBeenCalled();
      expect(notices.enqueue).toHaveBeenCalledOnce();
      expect(notices.enqueue).toHaveBeenCalledWith(prisma, expect.objectContaining({
        type: 'coach.application.approved', dedupeKey: 'coach.application.approved:mr1',
        recipient: { userId: 'u-new', email: 'jean@x.rw', firstName: 'Jean' }, payload: { activated: true },
      }));
      expect(notices.dispatchAfterCommit).toHaveBeenCalledWith(['outbox-1']);
    });

    it("copies the applicant's country and Olympiad interests to the Coach account (no other change)", async () => {
      const { service, prisma } = makeMocks();
      prisma.mentorRequest.findUnique.mockResolvedValue(pending({ country: 'KE', occupation: 'Teacher', educationLevel: 'MASTER', olympiadInterests: ['COMPUTING'] }));
      await service.approve('mr1', ADMIN);
      expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({ role: 'MENTOR', country: 'KE', olympiadInterests: ['COMPUTING'] });
    });

    it('with e-mail verification on, the account waits for the applicant to confirm the address', async () => {
      const { service, prisma, events, activation, settings, notices } = makeMocks();
      settings.get.mockResolvedValue(true);

      const result = await service.approve('mr1', ADMIN);

      expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({ role: 'MENTOR', activatedAt: null });
      expect(activation.issue).toHaveBeenCalledWith('u-new', 'EMAIL_VERIFICATION', 'a1', prisma);
      expect(activation.send).toHaveBeenCalledOnce();
      expect(events.emit).not.toHaveBeenCalled();
      expect(notices.enqueue).toHaveBeenCalledWith(prisma, expect.objectContaining({ payload: { activated: false } }));
      expect(result.emailVerificationRequired).toBe(true);
    });
  });

  describe('reject', () => {
    it('fails with INVALID_STATE_TRANSITION when already processed', async () => {
      const { service, prisma } = makeMocks();
      prisma.mentorRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reject('mr1', ADMIN)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('rejects a pending request and notifies the applicant (unchanged rejection e-mail; no approval notice)', async () => {
      const { service, events, notices } = makeMocks();
      await expect(service.reject('mr1', ADMIN)).resolves.toEqual({ id: 'mr1', status: 'REJECTED' });
      expect(events.emit).toHaveBeenCalledWith(Events.MentorRequestDecided, expect.objectContaining({ approved: false }));
      expect(notices.enqueue).not.toHaveBeenCalled();
    });
  });
});
