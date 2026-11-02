import { NotFoundException } from '@nestjs/common';
import { AssignmentsService } from './assignments.service.js';
import { Events } from '../notifications/events.js';
import type { AuthUser } from '../common/auth-user.js';

const MENTOR: AuthUser = { id: 'm1', username: 'mentor', role: 'MENTOR', divisionId: null, gradeLevel: null };
const ADMIN:  AuthUser = { id: 'a1', username: 'admin',  role: 'ADMIN',  divisionId: null, gradeLevel: null };

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);
const PAST   = () => new Date(Date.now() - 24 * 3600 * 1000);

function assignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'as1', title: 'Fractions', courseId: 'c1', divisionId: 'd1', status: 'DRAFT',
    deadline: FUTURE(), allowResubmission: false, maxResubmissions: 0, ...overrides,
  };
}

function makeMocks() {
  const prisma = {
    course:     { findUnique: vi.fn().mockResolvedValue({ id: 'c1', title: 'Maths' }) },
    assignment: {
      findUnique:         vi.fn().mockResolvedValue(assignment()),
      findUniqueOrThrow:  vi.fn().mockResolvedValue({ id: 'as1' }),
      create:             vi.fn().mockResolvedValue({ id: 'as1', title: 'Fractions' }),
      updateMany:         vi.fn().mockResolvedValue({ count: 1 }),
    },
    submission: { count: vi.fn().mockResolvedValue(0) },
  };
  const audit   = { log: vi.fn() };
  const access  = { assertMentorOf: vi.fn().mockResolvedValue(undefined) };
  const storage = { store: vi.fn().mockResolvedValue({ id: 'file-1' }) };
  const events  = { emit: vi.fn() };

  const service = new AssignmentsService(prisma as any, audit as any, access as any, storage as any, events as any);
  return { service, prisma, audit, access, storage, events };
}

const createDto = (overrides: Record<string, unknown> = {}) => ({
  title: 'Fractions', courseId: 'c1', divisionId: 'd1', instructions: 'Solve',
  deadline: FUTURE().toISOString(), points: 40, maximumMarks: 20, ...overrides,
}) as any;

describe('AssignmentsService', () => {
  describe('create', () => {
    it('creates a DRAFT owned by the mentor', async () => {
      const { service, prisma, access, audit } = makeMocks();
      await service.create(createDto(), MENTOR);
      expect(access.assertMentorOf).toHaveBeenCalledWith(MENTOR, { courseId: 'c1', divisionId: 'd1' });
      const data = prisma.assignment.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ status: 'DRAFT', createdById: 'm1', fileId: null, allowResubmission: false, maxResubmissions: 0 });
      expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE_ASSIGNMENT' }));
    });

    it('returns 404 when the course does not exist', async () => {
      const { service, prisma } = makeMocks();
      prisma.course.findUnique.mockResolvedValue(null);
      await expect(service.create(createDto(), MENTOR)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('propagates the access check failure (e.g. an admin or unassigned mentor)', async () => {
      const { service, prisma, access } = makeMocks();
      access.assertMentorOf.mockRejectedValue(Object.assign(new Error('no'), { code: 'NOT_ASSIGNED_TO_SCOPE' }));
      await expect(service.create(createDto(), ADMIN)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_SCOPE' });
      expect(prisma.assignment.create).not.toHaveBeenCalled();
    });

    it('rejects maxResubmissions without allowResubmission', async () => {
      const { service, prisma, storage } = makeMocks();
      await expect(service.create(createDto({ allowResubmission: false, maxResubmissions: 2 }), MENTOR))
        .rejects.toMatchObject({ code: 'INVALID_RESUBMISSION_RULES', status: 400 });
      expect(storage.store).not.toHaveBeenCalled();
      expect(prisma.assignment.create).not.toHaveBeenCalled();
    });

    it('stores an attached brief and links it', async () => {
      const { service, prisma, storage } = makeMocks();
      const file = { buffer: Buffer.from('x') } as Express.Multer.File;
      await service.create(createDto(), MENTOR, file);
      expect(storage.store).toHaveBeenCalledWith(file, 'ASSIGNMENT_BRIEF', 'm1');
      expect(prisma.assignment.create.mock.calls[0][0].data.fileId).toBe('file-1');
    });
  });

  describe('update', () => {
    it('refuses to edit a PUBLISHED assignment', async () => {
      const { service, prisma } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(assignment({ status: 'PUBLISHED' }));
      await expect(service.update('as1', { title: 'New' } as any, MENTOR))
        .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', status: 409 });
      expect(prisma.assignment.updateMany).not.toHaveBeenCalled();
    });

    it('requires at least one change', async () => {
      const { service } = makeMocks();
      await expect(service.update('as1', {} as any, MENTOR)).rejects.toMatchObject({ code: 'NO_CHANGES' });
    });

    it('validates resubmission rules against the stored values', async () => {
      const { service } = makeMocks();
      await expect(service.update('as1', { maxResubmissions: 3 } as any, MENTOR))
        .rejects.toMatchObject({ code: 'INVALID_RESUBMISSION_RULES' });
    });

    it('only updates while still DRAFT or REJECTED', async () => {
      const { service, prisma } = makeMocks();
      await service.update('as1', { title: 'New' } as any, MENTOR);
      expect(prisma.assignment.updateMany.mock.calls[0][0].where).toEqual({
        id: 'as1', status: { in: ['DRAFT', 'REJECTED'] },
      });
    });
  });

  describe('state transitions', () => {
    it('submitForReview refuses a past deadline', async () => {
      const { service, prisma } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(assignment({ deadline: PAST() }));
      await expect(service.submitForReview('as1', MENTOR)).rejects.toMatchObject({ code: 'DEADLINE_IN_PAST' });
    });

    it('submitForReview moves to PENDING_APPROVAL and emits an event', async () => {
      const { service, prisma, events } = makeMocks();
      await service.submitForReview('as1', MENTOR);
      expect(prisma.assignment.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'PENDING_APPROVAL' });
      expect(events.emit).toHaveBeenCalledWith(Events.AssignmentSubmittedForReview, { assignmentId: 'as1' });
    });

    it('throws INVALID_STATE_TRANSITION when the conditional update matches nothing', async () => {
      const { service, prisma } = makeMocks();
      prisma.assignment.updateMany.mockResolvedValue({ count: 0 });
      prisma.assignment.findUnique
        .mockResolvedValueOnce(assignment({ status: 'DRAFT' }))
        .mockResolvedValueOnce({ status: 'DRAFT' });

      const err = await service.recall('as1', MENTOR).catch((e) => e);

      expect(err).toMatchObject({ code: 'INVALID_STATE_TRANSITION', status: 409 });
      expect(err.getResponse().details).toEqual({ currentStatus: 'DRAFT', allowedFrom: ['PENDING_APPROVAL'] });
    });

    it('publish requires PENDING_APPROVAL, records the approver and emits an event', async () => {
      const { service, prisma, events } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(assignment({ status: 'PENDING_APPROVAL' }));
      await service.publish('as1', ADMIN);
      const call = prisma.assignment.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'as1', status: { in: ['PENDING_APPROVAL'] } });
      expect(call.data).toMatchObject({ status: 'PUBLISHED', approvedById: 'a1' });
      expect(events.emit).toHaveBeenCalledWith(Events.AssignmentPublished, { assignmentId: 'as1' });
    });

    it('publish refuses a past deadline', async () => {
      const { service, prisma } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(assignment({ status: 'PENDING_APPROVAL', deadline: PAST() }));
      await expect(service.publish('as1', ADMIN)).rejects.toMatchObject({ code: 'DEADLINE_IN_PAST' });
    });

    it('reject stores the note and emits an event', async () => {
      const { service, prisma, events } = makeMocks();
      await service.reject('as1', { rejectionNote: 'Fix Q2' } as any, ADMIN);
      expect(prisma.assignment.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'REJECTED', rejectionNote: 'Fix Q2' });
      expect(events.emit).toHaveBeenCalledWith(Events.AssignmentRejected, { assignmentId: 'as1', note: 'Fix Q2' });
    });

    it('unpublish is refused once submissions exist', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.count.mockResolvedValue(3);
      await expect(service.unpublish('as1', ADMIN)).rejects.toMatchObject({ code: 'ASSIGNMENT_HAS_SUBMISSIONS', status: 409 });
      expect(prisma.assignment.updateMany).not.toHaveBeenCalled();
    });

    it('unpublish returns a PUBLISHED assignment to DRAFT', async () => {
      const { service, prisma } = makeMocks();
      await service.unpublish('as1', ADMIN);
      const call = prisma.assignment.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: 'as1', status: { in: ['PUBLISHED'] } });
      expect(call.data).toEqual({ status: 'DRAFT', publishedAt: null, approvedById: null });
    });

    it('returns 404 for an unknown assignment', async () => {
      const { service, prisma } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(null);
      await expect(service.publish('nope', ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
