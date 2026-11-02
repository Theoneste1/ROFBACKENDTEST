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
      create:    vi.fn().mockResolvedValue({ id: 'u-new', username: 'jean', role: 'MENTOR' }),
    },
    mentorRequest: {
      findFirst:  vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(pending()),
      create:     vi.fn().mockResolvedValue({ id: 'mr-new' }),
      update:     vi.fn().mockResolvedValue({ id: 'mr1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));

  const audit  = { log: vi.fn() };
  const events = { emit: vi.fn() };
  const service = new MentorRequestsService(prisma as any, audit as any, events as any);
  return { service, prisma, audit, events };
}

describe('MentorRequestsService', () => {
  describe('create', () => {
    it('rejects an identity used by an existing user', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      await expect(service.create(dto)).rejects.toMatchObject({ code: 'IDENTITY_TAKEN', status: 409 });
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

    it('reuses a previously REJECTED request instead of creating a new one', async () => {
      const { service, prisma, audit } = makeMocks();
      prisma.mentorRequest.findFirst.mockResolvedValue(pending({ id: 'mr-old', status: 'REJECTED' }));

      await service.create(dto);

      expect(prisma.mentorRequest.create).not.toHaveBeenCalled();
      expect(prisma.mentorRequest.update).toHaveBeenCalledOnce();
      const call = prisma.mentorRequest.update.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'mr-old' });
      expect(call.data.status).toBe('PENDING');
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ metadata: { reapplication: true } }));
    });
  });

  describe('approve', () => {
    it('returns 404 for an unknown request', async () => {
      const { service, prisma } = makeMocks();
      prisma.mentorRequest.findUnique.mockResolvedValue(null);
      await expect(service.approve('nope', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('fails with INVALID_STATE_TRANSITION when the request was already processed', async () => {
      const { service, prisma, events } = makeMocks();
      prisma.mentorRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.approve('mr1', ADMIN)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', status: 409 });
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('fails with IDENTITY_TAKEN when a user grabbed the identity meanwhile', async () => {
      const { service, prisma } = makeMocks();
      prisma.user.findFirst.mockResolvedValue({ id: 'u1' });
      await expect(service.approve('mr1', ADMIN)).rejects.toMatchObject({ code: 'IDENTITY_TAKEN' });
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('creates a MENTOR account with the stored hash, clears it from the request and notifies', async () => {
      const { service, prisma, events } = makeMocks();

      const result = await service.approve('mr1', ADMIN);

      expect(prisma.mentorRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'mr1', status: 'PENDING' },
        data:  { status: 'APPROVED', passwordHash: null },
      });
      expect(prisma.user.create.mock.calls[0][0].data).toMatchObject({ role: 'MENTOR', passwordHash: 'hash' });
      expect(result.request).toEqual({ id: 'mr1', status: 'APPROVED' });
      expect(events.emit).toHaveBeenCalledWith(Events.MentorRequestDecided, {
        email: 'jean@x.rw', firstName: 'Jean', approved: true,
      });
    });
  });

  describe('reject', () => {
    it('fails with INVALID_STATE_TRANSITION when already processed', async () => {
      const { service, prisma } = makeMocks();
      prisma.mentorRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.reject('mr1', ADMIN)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('rejects a pending request and notifies the applicant', async () => {
      const { service, events } = makeMocks();
      await expect(service.reject('mr1', ADMIN)).resolves.toEqual({ id: 'mr1', status: 'REJECTED' });
      expect(events.emit).toHaveBeenCalledWith(Events.MentorRequestDecided, expect.objectContaining({ approved: false }));
    });
  });
});
