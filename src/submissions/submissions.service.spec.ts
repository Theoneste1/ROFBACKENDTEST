import { NotFoundException } from '@nestjs/common';
import { SubmissionsService } from './submissions.service.js';
import { Events } from '../notifications/events.js';
import type { AuthUser } from '../common/auth-user.js';

const STUDENT: AuthUser = { id: 's1', username: 'stu',    role: 'STUDENT', divisionId: 'd1', gradeLevel: 'S2' };
const MENTOR:  AuthUser = { id: 'm1', username: 'mentor', role: 'MENTOR',  divisionId: null, gradeLevel: null };
const OTHER:   AuthUser = { id: 'm2', username: 'other',  role: 'MENTOR',  divisionId: null, gradeLevel: null };
const ADMIN:   AuthUser = { id: 'a1', username: 'admin',  role: 'ADMIN',   divisionId: null, gradeLevel: null };

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);
const PAST   = () => new Date(Date.now() - 24 * 3600 * 1000);
const FILE   = { buffer: Buffer.from('%PDF-1.4'), originalname: 'work.pdf' } as Express.Multer.File;

function publishedAssignment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'as1', title: 'Fractions', status: 'PUBLISHED', deadline: FUTURE(), courseId: 'c1', divisionId: 'd1',
    allowResubmission: true, maxResubmissions: 0, allowLateSubmission: false, ...overrides,
  };
}

/** Row returned by requireSubmission (submission + scope + current/published review). */
function reviewRow(overrides: Record<string, unknown> = {}, review: Record<string, unknown> = {}) {
  return {
    id: 'sub1', status: 'IN_REVIEW', studentId: 's1', assignmentId: 'as1', pointsAwarded: 0,
    currentReviewId: 'r1',
    currentReview:   { id: 'r1', mentorId: 'm1', status: 'IN_PROGRESS', ...review },
    publishedReview: null,
    assignment: { courseId: 'c1', divisionId: 'd1', maximumMarks: 20 },
    ...overrides,
  };
}

function review(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1', cycle: 1, status: 'MARKED', score: 15, percentage: 75, feedback: 'Good',
    assignedAt: new Date(), startedAt: null, markedAt: null, returnedAt: null,
    decidedAt: null, decisionNote: null, coordinationNote: 'internal', publishedAt: null,
    mentor: { id: 'm1', username: 'mentor', firstName: 'M', lastName: 'One' },
    attachments: [], ...overrides,
  };
}

/** Row returned with SUBMISSION_INCLUDE (used by the role projections). */
function fullRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub1', status: 'MARKED', assignmentId: 'as1', studentId: 's1', revisionCount: 0, isLate: false,
    submittedAt: new Date(), pointsAwarded: 0, publishedAt: null, createdAt: new Date(), updatedAt: new Date(),
    assignment: { id: 'as1', title: 'Fractions', maximumMarks: 20, points: 40, deadline: FUTURE() },
    student: { id: 's1', firstName: 'S', lastName: 'One' },
    revisions: [], currentReview: review(), publishedReview: null, resultRelease: null,
    ...overrides,
  };
}

function makeMocks() {
  const prisma = {
    assignment: {
      findUnique: vi.fn().mockResolvedValue(publishedAssignment()),
    },
    submission: {
      findUnique:        vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn().mockResolvedValue(fullRow()),
      findMany:          vi.fn().mockResolvedValue([]),
      create:            vi.fn().mockResolvedValue({ id: 'sub1' }),
      update:            vi.fn().mockResolvedValue({}),
      updateMany:        vi.fn().mockResolvedValue({ count: 1 }),
      aggregate:         vi.fn().mockResolvedValue({ _sum: { pointsAwarded: 30 }, _count: { _all: 1 } }),
      groupBy:           vi.fn().mockResolvedValue([]),
    },
    submissionRevision: { create: vi.fn() },
    mentorReview: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue(null),
      aggregate:  vi.fn().mockResolvedValue({ _max: { cycle: 1 } }),
      create:     vi.fn().mockImplementation(({ data }) => Promise.resolve({ id: `rev-${data.mentorId}`, ...data })),
      groupBy:    vi.fn().mockResolvedValue([]),
    },
    reviewEvent:       { create: vi.fn().mockResolvedValue({}) },
    reviewAttachment:  {
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
      create:    vi.fn().mockResolvedValue({}),
    },
    distributionBatch: { create: vi.fn().mockResolvedValue({ id: 'b1' }), update: vi.fn() },
    resultRelease:     { create: vi.fn().mockResolvedValue({ id: 'rel1' }), update: vi.fn() },
    mentorAssignment:  { findMany: vi.fn().mockResolvedValue([]) },
    user:              { findUnique: vi.fn(), update: vi.fn() },
    $transaction:      vi.fn(),
  };
  // Interactive transactions receive the same mock as their `tx` client.
  const tx = prisma;
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: unknown) => unknown)(tx) : Promise.all(arg as unknown[]));

  const audit    = { log: vi.fn() };
  const access   = { assertCanView: vi.fn().mockResolvedValue(undefined), isAssignedMentor: vi.fn().mockResolvedValue(true) };
  const storage  = { store: vi.fn().mockResolvedValue({ id: 'file-1' }) };
  const settings = { get: vi.fn().mockResolvedValue('BALANCED') };
  const events   = { emit: vi.fn() };
  const activity = { record: vi.fn() };

  const service = new SubmissionsService(
    prisma as any, audit as any, access as any, storage as any, settings as any, events as any, activity as any,
  );
  return { service, prisma, tx, audit, access, storage, settings, events, activity };
}

describe('SubmissionsService', () => {
  describe('submit', () => {
    it('requires at least one file', async () => {
      const { service, prisma } = makeMocks();
      await expect(service.submit({ assignmentId: 'as1' } as any, STUDENT, []))
        .rejects.toMatchObject({ code: 'FILE_REQUIRED', status: 400 });
      await expect(service.submit({ assignmentId: 'as1' } as any, STUDENT))
        .rejects.toMatchObject({ code: 'FILE_REQUIRED' });
      expect(prisma.assignment.findUnique).not.toHaveBeenCalled();
    });

    it('hides unpublished assignments (404)', async () => {
      const { service, prisma, storage } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(publishedAssignment({ status: 'DRAFT' }));
      await expect(service.submit({ assignmentId: 'as1' } as any, STUDENT, [FILE])).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.store).not.toHaveBeenCalled();
    });

    it('refuses a late first submission when late work is not allowed, before storing the file', async () => {
      const { service, prisma, storage } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(publishedAssignment({ deadline: PAST() }));
      await expect(service.submit({ assignmentId: 'as1' } as any, STUDENT, [FILE]))
        .rejects.toMatchObject({ code: 'DEADLINE_PASSED' });
      expect(storage.store).not.toHaveBeenCalled();
    });

    it('refuses a resubmission when the assignment does not allow it', async () => {
      const { service, prisma } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(publishedAssignment({ allowResubmission: false }));
      prisma.submission.findUnique.mockResolvedValue({ id: 'sub1', status: 'SUBMITTED', revisionCount: 0, currentReviewId: null });
      await expect(service.submit({ assignmentId: 'as1' } as any, STUDENT, [FILE]))
        .rejects.toMatchObject({ code: 'RESUBMISSION_NOT_ALLOWED' });
    });

    it('enforces the resubmission limit', async () => {
      const { service, prisma } = makeMocks();
      prisma.assignment.findUnique.mockResolvedValue(publishedAssignment({ maxResubmissions: 2 }));
      prisma.submission.findUnique.mockResolvedValue({ id: 'sub1', status: 'SUBMITTED', revisionCount: 2, currentReviewId: null });
      await expect(service.submit({ assignmentId: 'as1' } as any, STUDENT, [FILE]))
        .rejects.toMatchObject({ code: 'RESUBMISSION_LIMIT_REACHED' });
    });

    it('refuses to replace work already under review', async () => {
      const { service, prisma, storage } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue({ id: 'sub1', status: 'IN_REVIEW', revisionCount: 0, currentReviewId: 'r1' });
      await expect(service.submit({ assignmentId: 'as1' } as any, STUDENT, [FILE]))
        .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(storage.store).not.toHaveBeenCalled();
    });

    it('a first submission stores every file as an ordered attachment of revision 1', async () => {
      const { service, prisma, storage, activity, events } = makeMocks();
      storage.store.mockResolvedValueOnce({ id: 'f1' }).mockResolvedValueOnce({ id: 'f2' });
      prisma.submission.findUniqueOrThrow.mockResolvedValue(fullRow({ status: 'SUBMITTED', currentReview: null }));

      await service.submit({ assignmentId: 'as1', note: 'hi' } as any, STUDENT, [FILE, FILE]);

      const data = prisma.submission.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ assignmentId: 'as1', studentId: 's1', status: 'SUBMITTED' });
      expect(data.revisions.create).toMatchObject({ revisionNumber: 1, note: 'hi' });
      expect(data.revisions.create.attachments.create).toEqual([
        { fileId: 'f1', sortOrder: 0 }, { fileId: 'f2', sortOrder: 1 },
      ]);
      expect(activity.record).toHaveBeenCalledWith('s1', 'SUBMISSION_CREATED', expect.objectContaining({ entityId: 'sub1' }));
      expect(events.emit).toHaveBeenCalledWith(Events.SubmissionReceived, { submissionId: 'sub1' });
    });

    it('a resubmission before review starts cancels the assigned review cycle', async () => {
      const { service, prisma, activity } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue({ id: 'sub1', status: 'ASSIGNED', revisionCount: 0, currentReviewId: 'r1' });
      prisma.submission.findUniqueOrThrow.mockResolvedValue(fullRow({ status: 'SUBMITTED', currentReview: null }));

      await service.submit({ assignmentId: 'as1' } as any, STUDENT, [FILE]);

      expect(prisma.submission.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'sub1', revisionCount: 0 },
        data:  { status: 'SUBMITTED', currentReviewId: null, revisionCount: 1 },
      });
      expect(prisma.mentorReview.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'r1', status: { in: ['ASSIGNED'] } }, data: { status: 'CANCELLED' },
      });
      expect(prisma.reviewEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ reviewId: 'r1', type: 'CANCELLED' }) });
      expect(prisma.submissionRevision.create.mock.calls[0][0].data).toMatchObject({ submissionId: 'sub1', revisionNumber: 2 });
      expect(activity.record).toHaveBeenCalledWith('s1', 'SUBMISSION_RESUBMITTED', expect.anything());
    });
  });

  describe('mentor review', () => {
    it('startReview by an ADMIN is refused with NOT_ASSIGNED_MENTOR', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'ASSIGNED' }, { status: 'ASSIGNED' }));
      await expect(service.startReview('sub1', ADMIN)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_MENTOR', status: 403 });
      expect(prisma.mentorReview.updateMany).not.toHaveBeenCalled();
      expect(prisma.submission.updateMany).not.toHaveBeenCalled();
    });

    it('startReview by a different mentor is refused', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'ASSIGNED' }, { status: 'ASSIGNED' }));
      await expect(service.startReview('sub1', OTHER)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_MENTOR' });
    });

    it('startReview without a current review is refused', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'SUBMITTED', currentReviewId: null, currentReview: null }));
      await expect(service.startReview('sub1', MENTOR)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_MENTOR' });
    });

    it('startReview moves the review to IN_PROGRESS only while still assigned to the mentor, and logs an event', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'ASSIGNED' }, { status: 'ASSIGNED' }));
      await service.startReview('sub1', MENTOR);
      expect(prisma.mentorReview.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'r1', status: { in: ['ASSIGNED', 'SENT_BACK'] }, mentorId: 'm1' },
        data:  { status: 'IN_PROGRESS' },
      });
      expect(prisma.submission.updateMany.mock.calls[0][0]).toEqual({
        where: { id: 'sub1', status: { in: ['ASSIGNED', 'REJECTED'] } }, data: { status: 'IN_REVIEW' },
      });
      expect(prisma.reviewEvent.create).toHaveBeenCalledWith({
        data: { reviewId: 'r1', type: 'STARTED', actorId: 'm1', note: null, score: null },
      });
    });

    it('a lost race on the review update fails with INVALID_STATE_TRANSITION', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'ASSIGNED' }, { status: 'ASSIGNED' }));
      prisma.mentorReview.updateMany.mockResolvedValue({ count: 0 });
      prisma.mentorReview.findUnique.mockResolvedValue({ status: 'SUPERSEDED' });
      await expect(service.startReview('sub1', MENTOR)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(prisma.submission.updateMany).not.toHaveBeenCalled();
    });

    it('mark rejects a score above maximumMarks with INVALID_SCORE', async () => {
      const { service, prisma, storage } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow());
      await expect(service.mark('sub1', { score: 21, mentorFeedback: 'x' } as any, MENTOR, [FILE]))
        .rejects.toMatchObject({ code: 'INVALID_SCORE', status: 400 });
      expect(storage.store).not.toHaveBeenCalled();
      expect(prisma.mentorReview.updateMany).not.toHaveBeenCalled();
    });

    it('mark requires the review to have started', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'ASSIGNED' }, { status: 'ASSIGNED' }));
      await expect(service.mark('sub1', { score: 10, mentorFeedback: 'x' } as any, MENTOR))
        .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    });

    it('mark by an ADMIN is refused', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow());
      await expect(service.mark('sub1', { score: 10, mentorFeedback: 'x' } as any, ADMIN))
        .rejects.toMatchObject({ code: 'NOT_ASSIGNED_MENTOR' });
    });

    it('mark by a different mentor is refused', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow());
      await expect(service.mark('sub1', { score: 10, mentorFeedback: 'x' } as any, OTHER))
        .rejects.toMatchObject({ code: 'NOT_ASSIGNED_MENTOR' });
    });

    it('mark saves score, percentage and feedback on the review, attaches files and hides the coordination note', async () => {
      const { service, prisma, storage } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow());
      storage.store.mockResolvedValueOnce({ id: 'fb1' }).mockResolvedValueOnce({ id: 'fb2' });

      const view = await service.mark('sub1', { score: 15, mentorFeedback: 'Good' } as any, MENTOR, [FILE, FILE]);

      expect(storage.store).toHaveBeenCalledWith(FILE, 'FEEDBACK', 'm1');
      expect(prisma.mentorReview.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'r1', status: { in: ['IN_PROGRESS', 'MARKED'] }, mentorId: 'm1' },
        data:  { status: 'MARKED', score: 15, percentage: 75, feedback: 'Good' },
      });
      expect(prisma.reviewEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ type: 'MARKED', score: 15 }) });
      expect(prisma.reviewAttachment.create.mock.calls.map((c) => c[0].data)).toEqual([
        { reviewId: 'r1', fileId: 'fb1', sortOrder: 0 }, { reviewId: 'r1', fileId: 'fb2', sortOrder: 1 },
      ]);
      expect(prisma.submission.updateMany.mock.calls[0][0]).toEqual({
        where: { id: 'sub1', status: { in: ['IN_REVIEW', 'MARKED'] } }, data: { status: 'MARKED' },
      });
      expect(view.review).not.toHaveProperty('coordinationNote');
      expect(view.review).toMatchObject({ score: 15, feedback: 'Good' });
    });

    it('submitToAdmin by an ADMIN is refused', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'MARKED' }, { status: 'MARKED' }));
      await expect(service.submitToAdmin('sub1', ADMIN)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_MENTOR' });
    });

    it('submitToAdmin by a different mentor is refused', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'MARKED' }, { status: 'MARKED' }));
      await expect(service.submitToAdmin('sub1', OTHER)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_MENTOR' });
    });

    it('submitToAdmin moves MARKED → RETURNED / SUBMITTED_TO_ADMIN and emits an event', async () => {
      const { service, prisma, events } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'MARKED' }, { status: 'MARKED' }));
      await service.submitToAdmin('sub1', MENTOR);
      expect(prisma.mentorReview.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'r1', status: { in: ['MARKED'] }, mentorId: 'm1' },
        data:  { status: 'RETURNED' },
      });
      expect(prisma.submission.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'sub1', status: { in: ['MARKED'] } },
        data:  { status: 'SUBMITTED_TO_ADMIN' },
      });
      expect(events.emit).toHaveBeenCalledWith(Events.ReviewReturned, { submissionId: 'sub1' });
    });
  });

  describe('admin coordination', () => {
    it('reassign to the same mentor is refused', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow());
      await expect(service.reassign('sub1', { mentorId: 'm1' }, ADMIN)).rejects.toMatchObject({ code: 'SAME_MENTOR' });
      expect(prisma.mentorReview.create).not.toHaveBeenCalled();
    });

    it('reassign supersedes the current cycle and starts the next one for the new mentor', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow());
      prisma.user.findUnique.mockResolvedValue({ role: 'MENTOR', isActive: true, isApproved: true });

      await service.reassign('sub1', { mentorId: 'm2' }, ADMIN);

      expect(prisma.mentorReview.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'r1' }, data: { status: 'SUPERSEDED' },
      });
      expect(prisma.mentorReview.create.mock.calls[0][0].data).toMatchObject({
        submissionId: 'sub1', mentorId: 'm2', status: 'ASSIGNED', assignedById: 'a1', cycle: 2,
      });
      expect(prisma.submission.update).toHaveBeenCalledWith({ where: { id: 'sub1' }, data: { currentReviewId: 'rev-m2' } });
    });

    it('assign refuses a non-mentor user', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'SUBMITTED', currentReviewId: null, currentReview: null }));
      prisma.user.findUnique.mockResolvedValue({ role: 'ADMIN', isActive: true, isApproved: true });
      await expect(service.assign('sub1', { mentorId: 'a1' }, ADMIN)).rejects.toMatchObject({ code: 'NOT_A_MENTOR' });
    });

    it('distribute fails with NO_ELIGIBLE_MENTORS when nobody is assigned to the scope', async () => {
      const { service, prisma } = makeMocks();
      await expect(service.distribute('as1', {} as any, ADMIN)).rejects.toMatchObject({ code: 'NO_ELIGIBLE_MENTORS' });
      expect(prisma.distributionBatch.create).not.toHaveBeenCalled();
    });

    it('distribute rejects explicitly chosen mentors outside the scope', async () => {
      const { service, prisma } = makeMocks();
      prisma.mentorAssignment.findMany.mockResolvedValue([{ mentorId: 'm1' }]);
      const err = await service.distribute('as1', { mentorIds: ['m1', 'm9'] } as any, ADMIN).catch((e) => e);
      expect(err).toMatchObject({ code: 'MENTOR_NOT_ELIGIBLE' });
      expect(err.getResponse().details).toEqual({ mentorIds: ['m9'] });
    });

    it('distribute deals submissions round-robin and records the batch', async () => {
      const { service, prisma } = makeMocks();
      prisma.mentorAssignment.findMany.mockResolvedValue([{ mentorId: 'm1' }, { mentorId: 'm2' }]);
      prisma.submission.findMany.mockResolvedValue([{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }]);

      const result = await service.distribute('as1', { strategy: 'ROUND_ROBIN' } as any, ADMIN);

      expect(result).toEqual({ batchId: 'b1', strategy: 'ROUND_ROBIN', distributed: 3, byMentor: { m1: 2, m2: 1 } });
      expect(prisma.distributionBatch.create).toHaveBeenCalledWith({
        data: { assignmentId: 'as1', strategy: 'ROUND_ROBIN', createdById: 'a1' },
      });
      const cycles = prisma.mentorReview.create.mock.calls.map((c) => c[0].data);
      expect(cycles.map((d) => [d.submissionId, d.mentorId])).toEqual([['x1', 'm1'], ['x2', 'm2'], ['x3', 'm1']]);
      expect(cycles.every((d) => d.distributionBatchId === 'b1')).toBe(true);
      expect(prisma.distributionBatch.update).toHaveBeenCalledWith({ where: { id: 'b1' }, data: { assignedCount: 3 } });
    });

    it('distribute (balanced) prefers the mentor with the lightest open review workload', async () => {
      const { service, prisma, settings } = makeMocks();
      prisma.mentorAssignment.findMany.mockResolvedValue([{ mentorId: 'm1' }, { mentorId: 'm2' }]);
      prisma.submission.findMany.mockResolvedValue([{ id: 'x1' }, { id: 'x2' }]);
      prisma.mentorReview.groupBy.mockResolvedValue([{ mentorId: 'm1', _count: { _all: 5 } }]);

      const result = await service.distribute('as1', {} as any, ADMIN);

      expect(settings.get).toHaveBeenCalledWith('submissions.defaultDistributionStrategy');
      expect(prisma.mentorReview.groupBy.mock.calls[0][0]).toMatchObject({
        by: ['mentorId'], where: { mentorId: { in: ['m1', 'm2'] } },
      });
      expect(result).toMatchObject({ batchId: 'b1', strategy: 'BALANCED', distributed: 2, byMentor: { m2: 2 } });
    });

    it('publish awards points scaled by score (15/20 of 40 → 30), records a release and recomputes the student total', async () => {
      const { service, prisma, events } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'APPROVED' }, { status: 'APPROVED' }));
      prisma.submission.findMany.mockResolvedValue([
        { id: 'sub1', studentId: 's1', currentReviewId: 'r1', currentReview: { score: 15 }, assignment: { points: 40, maximumMarks: 20 } },
      ]);

      await service.publish('sub1', ADMIN);

      expect(prisma.resultRelease.create.mock.calls[0][0].data).toMatchObject({ assignmentId: 'as1', publishedById: 'a1' });
      expect(prisma.submission.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'sub1', status: 'APPROVED' },
        data:  { status: 'PUBLISHED', pointsAwarded: 30, publishedReviewId: 'r1', resultReleaseId: 'rel1' },
      });
      expect(prisma.mentorReview.updateMany.mock.calls[0][0]).toMatchObject({
        where: { id: 'r1', status: { in: ['APPROVED'] } }, data: { status: 'PUBLISHED' },
      });
      expect(prisma.resultRelease.update).toHaveBeenCalledWith({ where: { id: 'rel1' }, data: { resultCount: 1 } });
      expect(prisma.submission.aggregate.mock.calls[0][0].where).toEqual({ studentId: 's1', status: 'PUBLISHED' });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 's1' }, data: { points: 30, problemsSolved: 1 },
      });
      expect(events.emit).toHaveBeenCalledWith(Events.ResultsPublished, { submissionIds: ['sub1'] });
    });

    it('publish of a non-APPROVED result fails with INVALID_STATE_TRANSITION', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'MARKED' }, { status: 'MARKED' }));
      await expect(service.publish('sub1', ADMIN)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(prisma.resultRelease.create).not.toHaveBeenCalled();
    });

    it('reopen only applies to PUBLISHED results', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(reviewRow({ status: 'APPROVED' }, { status: 'APPROVED' }));
      await expect(service.reopen('sub1', { reopenNote: 'typo' } as any, ADMIN))
        .rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
      expect(prisma.submission.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('visibility', () => {
    it('a mentor cannot load a submission whose current review belongs to someone else (404)', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(fullRow());
      await expect(service.findOne('sub1', OTHER)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a student does not see score or feedback before publication', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(fullRow({ status: 'MARKED' }));
      const view = await service.findOne('sub1', STUDENT);
      expect(view).not.toHaveProperty('result');
      expect(view).not.toHaveProperty('review');
      expect(view).toMatchObject({ displayStatus: 'In Review' });
    });

    it('a student cannot download feedback before publication', async () => {
      const { service, prisma } = makeMocks();
      prisma.submission.findUnique.mockResolvedValue(fullRow({ status: 'APPROVED' }));
      await expect(service.serveFeedbackFile('sub1', STUDENT, {} as any))
        .rejects.toMatchObject({ code: 'RESULT_NOT_PUBLISHED' });
    });
  });
});
