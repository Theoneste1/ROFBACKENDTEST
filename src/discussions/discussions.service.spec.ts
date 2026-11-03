import { DiscussionsService } from './discussions.service.js';
import { Prisma } from '../generated/prisma/client.js';
import type { AuthUser } from '../common/auth-user.js';

const STUDENT: AuthUser = { id: 's1', username: 'stu',   role: 'STUDENT', divisionId: 'd1', gradeLevel: 'S2' };
const OTHER:   AuthUser = { id: 's2', username: 'other', role: 'STUDENT', divisionId: 'd1', gradeLevel: 'S2' };
const ADMIN:   AuthUser = { id: 'a1', username: 'admin', role: 'ADMIN',   divisionId: null, gradeLevel: null };

const thread = (overrides: Record<string, unknown> = {}) => ({
  id: 't1', title: 'Topic', courseId: 'c1', assignmentId: null, divisionId: 'd1', status: 'OPEN', createdById: 's1', ...overrides,
});

const comment = (overrides: Record<string, unknown> = {}) => ({
  id: 'cm1', threadId: 't1', authorId: 's1', parentId: null, status: 'ACTIVE', content: 'hi',
  thread: { status: 'OPEN' }, ...overrides,
});

const code = (err: unknown) => (err as { getResponse(): { code: string } }).getResponse().code;

function makeMocks() {
  const prisma = {
    discussionThread: {
      findUnique: vi.fn().mockResolvedValue(thread()),
      update:     vi.fn().mockResolvedValue({}),
    },
    comment: {
      findUnique: vi.fn().mockResolvedValue(comment()),
      create:     vi.fn(),
      update:     vi.fn(),
      count:      vi.fn().mockResolvedValue(0),
    },
    contentReport: {
      findUnique:        vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany:          vi.fn().mockResolvedValue([{ id: 'rep1' }]),
      create:            vi.fn().mockResolvedValue({ id: 'rep1', reason: 'SPAM', status: 'OPEN' }),
      updateMany:        vi.fn(),
    },
    moderationAction: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function' ? (arg as (t: unknown) => unknown)(prisma) : Promise.all(arg as unknown[]));

  const audit    = { log: vi.fn() };
  const access   = { assertCanView: vi.fn().mockResolvedValue(undefined), studentDivision: vi.fn().mockReturnValue('d1') };
  const activity = { record: vi.fn() };
  const events   = { emit: vi.fn() };

  const service = new DiscussionsService(prisma as any, audit as any, access as any, activity as any, events as any);
  return { service, prisma, audit, access, activity, events };
}

describe('DiscussionsService', () => {
  it('createComment on a LOCKED thread fails with INVALID_STATE_TRANSITION', async () => {
    const { service, prisma, activity } = makeMocks();
    prisma.discussionThread.findUnique.mockResolvedValue(thread({ status: 'LOCKED' }));
    const err = await service.createComment('t1', { content: 'reply' } as any, STUDENT).catch((e) => e);
    expect(code(err)).toBe('INVALID_STATE_TRANSITION');
    expect(prisma.comment.create).not.toHaveBeenCalled();
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('reportComment on your own comment fails with CANNOT_REPORT_OWN', async () => {
    const { service, prisma } = makeMocks();
    const err = await service.reportComment('cm1', { reason: 'SPAM' } as any, STUDENT).catch((e) => e);
    expect(code(err)).toBe('CANNOT_REPORT_OWN');
    expect(prisma.contentReport.create).not.toHaveBeenCalled();
  });

  it('reportComment creates a report with a snapshot of the text and tells the admins', async () => {
    const { service, prisma, events } = makeMocks();
    await service.reportComment('cm1', { reason: 'SPAM' } as any, OTHER);
    expect(prisma.contentReport.create.mock.calls[0][0].data).toMatchObject({
      commentId: 'cm1', reporterId: 's2', reason: 'SPAM', contentSnapshot: 'hi',
    });
    expect(events.emit).toHaveBeenCalledWith('moderation.content_reported', { reportId: 'rep1' });
  });

  it('a deleted comment cannot be reported', async () => {
    const { service, prisma } = makeMocks();
    prisma.comment.findUnique.mockResolvedValue(comment({ status: 'DELETED' }));
    const err = await service.reportComment('cm1', { reason: 'SPAM' } as any, OTHER).catch((e) => e);
    expect(code(err)).toBe('INVALID_STATE_TRANSITION');
    expect(prisma.contentReport.create).not.toHaveBeenCalled();
  });

  it('a duplicate report (P2002) fails with ALREADY_REPORTED', async () => {
    const { service, prisma } = makeMocks();
    prisma.contentReport.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' }),
    );
    const err = await service.reportComment('cm1', { reason: 'SPAM' } as any, OTHER).catch((e) => e);
    expect(code(err)).toBe('ALREADY_REPORTED');
    expect(err.getStatus()).toBe(409);
  });

  it('other report errors are rethrown unchanged', async () => {
    const { service, prisma } = makeMocks();
    const boom = new Error('db down');
    prisma.contentReport.create.mockRejectedValue(boom);
    await expect(service.reportThread('t1', { reason: 'SPAM' } as any, OTHER)).rejects.toBe(boom);
  });

  it('resolveReport with action LOCK on a comment report fails with INVALID_ACTION', async () => {
    const { service, prisma } = makeMocks();
    prisma.contentReport.findUnique.mockResolvedValue({ id: 'rep1', status: 'OPEN', commentId: 'cm1', threadId: null });
    const err = await service.resolveReport('rep1', { action: 'LOCK' } as any, ADMIN).catch((e) => e);
    expect(code(err)).toBe('INVALID_ACTION');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.moderationAction.create).not.toHaveBeenCalled();
  });

  it('resolveReport with HIDE on a comment report hides it, records the action and resolves open reports', async () => {
    const { service, prisma, audit } = makeMocks();
    prisma.contentReport.findUnique.mockResolvedValue({
      id: 'rep1', status: 'OPEN', commentId: 'cm1', threadId: null, comment: { status: 'ACTIVE', threadId: 't1' }, thread: null,
    });
    await service.resolveReport('rep1', { action: 'HIDE', note: 'rude' } as any, ADMIN);
    expect(prisma.comment.update).toHaveBeenCalledWith({ where: { id: 'cm1' }, data: { status: 'HIDDEN' } });
    expect(prisma.moderationAction.create.mock.calls[0][0].data).toMatchObject({
      moderatorId: 'a1', action: 'HIDE_COMMENT', commentId: 'cm1', reportId: 'rep1', reason: 'rude',
    });
    expect(prisma.contentReport.findMany.mock.calls[0][0].where).toEqual({ commentId: 'cm1', status: 'OPEN' });
    expect(prisma.contentReport.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['rep1'] }, status: 'OPEN' }, data: { status: 'RESOLVED', resolvedById: 'a1' },
    });
    expect(audit.log).toHaveBeenCalled();
  });

  it('resolveReport refuses to act on content that is already removed', async () => {
    const { service, prisma } = makeMocks();
    prisma.contentReport.findUnique.mockResolvedValue({
      id: 'rep1', status: 'OPEN', commentId: 'cm1', threadId: null, comment: { status: 'DELETED', threadId: 't1' }, thread: null,
    });
    const err = await service.resolveReport('rep1', { action: 'HIDE' } as any, ADMIN).catch((e) => e);
    expect(code(err)).toBe('INVALID_STATE_TRANSITION');
    expect(prisma.moderationAction.create).not.toHaveBeenCalled();
  });

  it('an administrator\'s removal keeps the text for the record; an author\'s erases it', async () => {
    const { service, prisma, events } = makeMocks();
    await service.removeComment('cm1', ADMIN, 'abusive');
    expect(prisma.comment.update.mock.calls[0][0].data).not.toHaveProperty('content');
    expect(prisma.moderationAction.create.mock.calls[0][0].data).toMatchObject({ action: 'DELETE_COMMENT', reason: 'abusive' });
    expect(events.emit).toHaveBeenCalledWith('moderation.content_moderated', expect.objectContaining({ action: 'DELETE_COMMENT' }));

    const own = makeMocks();
    await own.service.removeComment('cm1', STUDENT);
    expect(own.prisma.comment.update.mock.calls[0][0].data).toMatchObject({ status: 'DELETED', content: '[deleted]' });
    expect(own.prisma.moderationAction.create).not.toHaveBeenCalled();
    expect(own.events.emit).not.toHaveBeenCalled();
  });

  it('an author cannot delete a thread others have posted in', async () => {
    const { service, prisma } = makeMocks();
    prisma.comment.count.mockResolvedValue(1);
    const err = await service.deleteThread('t1', STUDENT).catch((e) => e);
    expect(code(err)).toBe('THREAD_HAS_REPLIES');
    expect(prisma.discussionThread.update).not.toHaveBeenCalled();

    const other = await service.deleteThread('t1', OTHER).catch((e) => e);
    expect(code(other)).toBe('NOT_AUTHOR');
  });

  it('an administrator removes any thread and the removal is recorded', async () => {
    const { service, prisma } = makeMocks();
    await service.deleteThread('t1', ADMIN, 'spam');
    expect(prisma.discussionThread.update.mock.calls[0][0].data).toMatchObject({ status: 'DELETED' });
    expect(prisma.moderationAction.create.mock.calls[0][0].data).toMatchObject({ action: 'DELETE_THREAD', threadId: 't1', reason: 'spam' });
    expect(prisma.comment.count).not.toHaveBeenCalled();
  });

  it('a deleted thread is not visible to students', async () => {
    const { service, prisma } = makeMocks();
    prisma.discussionThread.findUnique.mockResolvedValue(thread({ status: 'DELETED' }));
    await expect(service.getThread('t1', STUDENT)).rejects.toThrow('Thread not found.');
  });

  it('updateComment by someone other than the author fails with NOT_AUTHOR', async () => {
    const { service, prisma } = makeMocks();
    const err = await service.updateComment('cm1', { content: 'edited' } as any, OTHER).catch((e) => e);
    expect(code(err)).toBe('NOT_AUTHOR');
    expect(err.getStatus()).toBe(403);
    expect(prisma.comment.update).not.toHaveBeenCalled();
  });
});
