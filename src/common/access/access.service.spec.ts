import { NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth-user.js';
import { AccessService } from './access.service.js';

const SCOPE = { courseId: 'c1', divisionId: 'd1' };

function makeService(opts: { assigned?: boolean; courseStatus?: string; offered?: boolean; programmes?: string[]; programmeOffers?: Array<{ courseId: string; divisionId: string }> } = {}) {
  const active = [{ courseId: 'c1', divisionId: 'd1' }, { courseId: 'c2', divisionId: 'd2' }];
  const prisma = {
    mentorAssignment: {
      findMany:  vi.fn().mockResolvedValue(opts.assigned === false ? [] : active),
      findFirst: vi.fn().mockResolvedValue(opts.assigned === false ? null : { id: 'ma1' }),
    },
    course: { findUnique: vi.fn().mockResolvedValue({ status: opts.courseStatus ?? 'PUBLISHED', divisionOfferings: opts.offered === false ? [] : [{ id: 'o1' }] }) },
    // Programme-wide coach access (owner 2026-11-23): the programmes kept (restrictions already applied by the query).
    programmeMembership: { findMany: vi.fn().mockResolvedValue((opts.programmes ?? []).map((disciplineId) => ({ disciplineId }))) },
    courseDivision: {
      findMany: vi.fn().mockResolvedValue(opts.programmeOffers ?? []),
      count: vi.fn().mockImplementation(({ where }: { where: { courseId: string; divisionId: string } }) =>
        Promise.resolve((opts.programmeOffers ?? []).filter((o) => o.courseId === where.courseId && o.divisionId === where.divisionId).length)),
    },
  };
  return { service: new AccessService(prisma as never), prisma };
}

const user = (role: string, extra: Partial<AuthUser> = {}): AuthUser =>
  ({ id: 'u1', username: 'u1', role, divisionId: null, gradeLevel: null, ...extra }) as unknown as AuthUser;

const UNKNOWN = 'UNKNOWN_ROLE';

describe('AccessService — known roles keep their behaviour', () => {
  it('admins view and manage every scope; scopeFilter is unrestricted', async () => {
    const { service } = makeService();
    await expect(service.assertCanView(user('ADMIN'), SCOPE)).resolves.toBeUndefined();
    await expect(service.assertCanManage(user('ADMIN'), SCOPE)).resolves.toBeUndefined();
    await expect(service.scopeFilter(user('ADMIN'))).resolves.toBeUndefined();
  });

  it('admins are not coaches (assertMentorOf refuses them)', async () => {
    const { service } = makeService();
    await expect(service.assertMentorOf(user('ADMIN'), SCOPE)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_SCOPE' });
  });

  it('coaches: assigned scopes only; scopeFilter lists their active assignments', async () => {
    const { service } = makeService();
    await expect(service.assertCanView(user('MENTOR'), SCOPE)).resolves.toBeUndefined();
    await expect(service.assertCanManage(user('MENTOR'), SCOPE)).resolves.toBeUndefined();
    await expect(service.assertMentorOf(user('MENTOR'), SCOPE)).resolves.toBeUndefined();
    await expect(service.scopeFilter(user('MENTOR'))).resolves.toEqual({
      OR: [{ courseId: 'c1', divisionId: 'd1' }, { courseId: 'c2', divisionId: 'd2' }],
    });
  });

  it('owner 2026-11-23: a Coach also works in every course of their programmes, at every level it is offered in', async () => {
    const { service, prisma } = makeService({ assigned: false, programmes: ['maths'], programmeOffers: [{ courseId: 'c1', divisionId: 'd1' }, { courseId: 'c1', divisionId: 'd3' }] });
    await expect(service.assertCanView(user('MENTOR'), SCOPE)).resolves.toBeUndefined();
    await expect(service.assertCanManage(user('MENTOR'), SCOPE)).resolves.toBeUndefined();
    await expect(service.assertMentorOf(user('MENTOR'), { courseId: 'c1', divisionId: 'd3' })).resolves.toBeUndefined();
    await expect(service.assertCanView(user('MENTOR'), { courseId: 'c9', divisionId: 'd1' })).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_SCOPE' });
    await expect(service.scopeFilter(user('MENTOR'))).resolves.toEqual({ OR: [{ courseId: 'c1', divisionId: 'd1' }, { courseId: 'c1', divisionId: 'd3' }] });
    // The programmes are read with the restrictions applied (COURSES), for this coach only.
    expect(prisma.programmeMembership.findMany.mock.calls[0][0].where).toMatchObject({
      userId: 'u1', isActive: true, discipline: { coachRestrictions: { none: { coachId: 'u1', capability: 'COURSES', liftedAt: null } } },
    });
    // Explicit assignments are still the only ones grading uses.
    await expect(service.isAssignedMentor('u1', SCOPE)).resolves.toBe(false);
  });

  it('owner 2026-11-23: a Head Coach gets no programme-wide course work (H4 unchanged); explicit and programme scopes are not doubled', async () => {
    const hc = makeService({ assigned: false, programmes: ['maths'], programmeOffers: [{ courseId: 'c1', divisionId: 'd1' }] });
    await expect(hc.service.assertMentorOf(user('HEAD_COACH'), SCOPE)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_SCOPE' });
    expect(hc.prisma.programmeMembership.findMany).not.toHaveBeenCalled();
    const both = makeService({ programmes: ['maths'], programmeOffers: [{ courseId: 'c1', divisionId: 'd1' }, { courseId: 'c3', divisionId: 'd1' }] });
    await expect(both.service.courseScopes(user('MENTOR'))).resolves.toEqual([
      { courseId: 'c1', divisionId: 'd1' }, { courseId: 'c2', divisionId: 'd2' }, { courseId: 'c3', divisionId: 'd1' },
    ]);
  });

  it('coaches without assignments: refused, and scopeFilter matches nothing', async () => {
    const { service } = makeService({ assigned: false });
    await expect(service.assertCanView(user('MENTOR'), SCOPE)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_SCOPE' });
    await expect(service.scopeFilter(user('MENTOR'))).resolves.toEqual({ id: { in: [] } });
  });

  it('students: own division and published courses only', async () => {
    const { service } = makeService();
    await expect(service.assertCanView(user('STUDENT', { divisionId: 'd1' }), SCOPE)).resolves.toBeUndefined();
    await expect(service.assertCanView(user('STUDENT', { divisionId: 'd2' }), SCOPE)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.scopeFilter(user('STUDENT', { divisionId: 'd1' }))).resolves.toEqual({
      divisionId: 'd1', course: { status: 'PUBLISHED', divisionOfferings: { some: { divisionId: 'd1', isActive: true } } },
    });
    await expect(service.assertCanManage(user('STUDENT', { divisionId: 'd1' }), SCOPE)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_SCOPE' });
  });

  it('students: a course their division does not offer is not revealed (404)', async () => {
    const { service } = makeService({ offered: false });
    await expect(service.assertCanView(user('STUDENT', { divisionId: 'd1' }), SCOPE)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('students in an unpublished course: 404', async () => {
    const { service } = makeService({ courseStatus: 'DRAFT' });
    await expect(service.assertCanView(user('STUDENT', { divisionId: 'd1' }), SCOPE)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('AccessService — an unsupported role gets least privilege', () => {
  it('assertCanView: 404', async () => {
    const { service } = makeService();
    await expect(service.assertCanView(user(UNKNOWN), SCOPE)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('assertCanManage and assertMentorOf: 403 even with coach assignments on record', async () => {
    const { service } = makeService({ assigned: true });
    await expect(service.assertCanManage(user(UNKNOWN), SCOPE)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_SCOPE' });
    await expect(service.assertMentorOf(user(UNKNOWN), SCOPE)).rejects.toMatchObject({ code: 'NOT_ASSIGNED_TO_SCOPE' });
  });

  it('scopeFilter: 403 ROLE_NOT_SUPPORTED — never inherits coach scope from MentorAssignment rows (former coach)', async () => {
    const { service, prisma } = makeService({ assigned: true });
    await expect(service.scopeFilter(user(UNKNOWN))).rejects.toMatchObject({ code: 'ROLE_NOT_SUPPORTED' });
    expect(prisma.mentorAssignment.findMany).not.toHaveBeenCalled();
  });

  it('scopeFilter: a division on the caller does not make an unsupported role a student', async () => {
    const { service } = makeService();
    await expect(service.scopeFilter(user(UNKNOWN, { divisionId: 'd1' }))).rejects.toMatchObject({ code: 'ROLE_NOT_SUPPORTED' });
  });
});
