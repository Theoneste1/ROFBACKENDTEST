/**
 * Coaches' subject interests (owner decision 2026-11-19, Option A; capability coachOlympiadInterests): the request rules
 * (a new coach application must name at least one subject; a Coach's own edit and an Administrator's edit need at least
 * one when sent; never empty, unknown or duplicate values) and the Administrator's edit in UsersService.update (Coach
 * accounts only, stored in the fixed order, audited). Information only: no permission depends on interests.
 */
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { ROLE_GRANTS } from '../auth/permissions.js';
import { CreateMentorRequestDto } from '../mentor-requests/dto/create-mentor-request.dto.js';
import { UpdateMeDto, UpdateUserDto } from './dto/update-user.dto.js';
import { UsersService } from './users.service.js';

/** The validation messages of a body, grouped by property. */
const problems = <T extends object>(cls: new () => T, body: object) => {
  const errors = validateSync(plainToInstance(cls, body) as object, { whitelist: true, forbidNonWhitelisted: true });
  return Object.fromEntries(errors.map((e) => [e.property, Object.values(e.constraints ?? {})]));
};

const APPLICANT = { firstName: 'Jean', lastName: 'Coach', username: 'jean.c', email: 'jean@example.rw', password: 'Secret123', gender: 'MALE' };
const BAD = [[], ['CHEMISTRY'], ['MATHEMATICS', 'MATHEMATICS'], 'MATHEMATICS', [null]];

describe('coach subject interests: request rules', () => {
  it('a new coach application needs one, two or three subjects', () => {
    for (const ok of [['PHYSICS'], ['PHYSICS', 'MATHEMATICS'], ['COMPUTING', 'PHYSICS', 'MATHEMATICS']]) {
      expect(problems(CreateMentorRequestDto, { ...APPLICANT, olympiadInterests: ok })).toEqual({});
    }
    expect(Object.keys(problems(CreateMentorRequestDto, APPLICANT))).toEqual(['olympiadInterests']);
    for (const bad of BAD) {
      expect(Object.keys(problems(CreateMentorRequestDto, { ...APPLICANT, olympiadInterests: bad }))).toEqual(['olympiadInterests']);
    }
  });

  it('a Coach editing their own (PATCH /me) and an Administrator (PATCH /admin/users/:id): optional, at least one when sent', () => {
    for (const cls of [UpdateMeDto, UpdateUserDto]) {
      expect(problems(cls, {})).toEqual({});
      expect(problems(cls, { olympiadInterests: ['COMPUTING', 'MATHEMATICS'] })).toEqual({});
      for (const bad of BAD) expect(Object.keys(problems(cls, { olympiadInterests: bad }))).toEqual(['olympiadInterests']);
    }
  });

  it('no role is granted anything by interests: no permission mentions them', () => {
    const names = Object.values(ROLE_GRANTS).flatMap((g) => Object.keys(g));
    expect(names.filter((p) => /interest|subject|olympiad/i.test(p))).toEqual([]);
  });
});

function makeService(target: { id: string; role: string; olympiadInterests?: string[] }) {
  const row = { username: 'coach', email: 'coach@x.rw', gradeLevel: null, firstName: 'C', lastName: 'Oach', divisionId: null, schoolId: null, homeLocation: null, isActive: true, activatedAt: new Date(), ...target };
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue(row),
      findFirst: vi.fn().mockResolvedValue(null),
      // The written row: the fields that were set (undefined = unchanged, as in Prisma).
      update: vi.fn((args: { data: Record<string, unknown> }) => Promise.resolve({
        ...row, olympiadInterests: row.olympiadInterests ?? [],
        ...Object.fromEntries(Object.entries(args.data).filter(([, v]) => v !== undefined)),
      })),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ...row, olympiadInterests: row.olympiadInterests ?? [] }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  const audit = { log: vi.fn() };
  const roles = { assertCanAssign: vi.fn(), assertCanManage: vi.fn(), assertSharedAccountRules: vi.fn() };
  const affiliations = { beginUserChange: vi.fn().mockResolvedValue(null), claim: vi.fn() };
  const service = new UsersService(
    prisma as any, audit as any, { idForGrade: vi.fn() } as any, { revokeAllForUser: vi.fn(), lockSessions: vi.fn() } as any,
    { enrollInCurrentYear: vi.fn() } as any, {} as any, roles as any, affiliations as any, {} as any,
  );
  return { service, prisma, audit, roles };
}

const ADMIN = { id: 'admin-1', role: 'ADMIN' };

describe('coach subject interests: an Administrator edits a Coach (UsersService.update)', () => {
  it('checks the right to manage the account first, then stores the subjects in the fixed order and audits the change', async () => {
    const { service, prisma, audit, roles } = makeService({ id: 'c1', role: 'MENTOR', olympiadInterests: [] });
    await service.update('c1', { olympiadInterests: ['PHYSICS', 'MATHEMATICS'] } as any, ADMIN as any);
    expect(roles.assertCanManage).toHaveBeenCalledWith(ADMIN, 'MENTOR');
    expect(prisma.user.update.mock.calls[0][0].data.olympiadInterests).toEqual(['MATHEMATICS', 'PHYSICS']);
    const entry = audit.log.mock.calls.find((c) => c[0].action === 'UPDATE_USER')![0];
    expect(entry.metadata.changes).toEqual({ olympiadInterests: { from: [], to: ['MATHEMATICS', 'PHYSICS'] } });
  });

  it('the same subjects again: nothing to record', async () => {
    const { service, audit } = makeService({ id: 'c1', role: 'MENTOR', olympiadInterests: ['MATHEMATICS'] });
    await service.update('c1', { olympiadInterests: ['MATHEMATICS'] } as any, ADMIN as any);
    expect(audit.log.mock.calls.find((c) => c[0].action === 'UPDATE_USER')![0].metadata.changes).toEqual({});
  });

  it.each([
    ['a Student', { id: 's1', role: 'STUDENT', gradeLevel: 'S2' }, {}],
    ['a Teacher', { id: 't1', role: 'TEACHER' }, {}],
    ['a Coach being given another role', { id: 'c1', role: 'MENTOR' }, { role: 'TEACHER' }],
  ])('refused for %s (400 INTERESTS_COACH_ONLY); nothing written', async (_label, target, extra) => {
    const { service, prisma } = makeService(target as any);
    await expect(service.update(target.id, { olympiadInterests: ['MATHEMATICS'], ...extra } as any, ADMIN as any)).rejects.toMatchObject({ code: 'INTERESTS_COACH_ONLY' });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('an edit without interests never fills them in', async () => {
    const { service, prisma } = makeService({ id: 'c1', role: 'MENTOR', olympiadInterests: [] });
    await service.update('c1', { firstName: 'New' } as any, ADMIN as any);
    expect(prisma.user.update.mock.calls[0][0].data).not.toHaveProperty('olympiadInterests');
  });
});
