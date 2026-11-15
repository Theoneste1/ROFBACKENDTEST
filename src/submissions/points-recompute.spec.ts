import { SubmissionsService } from './submissions.service.js';
import type { AuthUser } from '../common/auth-user.js';

const ADMIN: AuthUser = { id: 'a1', username: 'admin', role: 'ADMIN', divisionId: null, gradeLevel: null };

/** SubmissionsService with only what recomputeAllPoints touches. */
function make(changed = 3, students = 100_000) {
  const order: string[] = [];
  const tx = {
    $queryRaw:   vi.fn(async () => { order.push('lock'); return []; }),
    $executeRaw: vi.fn(async () => { order.push('update'); return changed; }),
    user:        { count: vi.fn(async () => { order.push('count'); return students; }), update: vi.fn(), findMany: vi.fn() },
  };
  const prisma = {
    user: { findMany: vi.fn(), findUnique: vi.fn() },
    $transaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(tx)),
  };
  const audit = { log: vi.fn() };
  const service = new SubmissionsService(prisma as any, audit as any, {} as any, {} as any, {} as any, { emit: vi.fn() } as any, {} as any);
  return { service, prisma, tx, audit, order };
}

describe('recomputeAllPoints (M6: one set-based statement, not one transaction per student)', () => {
  it('takes the recompute lock, counts students and runs ONE update — no per-student queries', async () => {
    const { service, tx, order, prisma } = make();
    const res = await service.recomputeAllPoints(ADMIN);
    expect(order).toEqual(['lock', 'count', 'update']);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(res).toEqual({ recomputed: 100_000, changed: 3 });
    expect(tx.user.count).toHaveBeenCalledWith({ where: { role: 'STUDENT' } });
  });

  it('the statement sums PUBLISHED results per student, covers students without results, and writes only differences', async () => {
    const { service, tx } = make();
    await service.recomputeAllPoints(ADMIN);
    const sql = (tx.$executeRaw.mock.calls[0] as unknown[])[0] as TemplateStringsArray;
    const text = sql.join('?').replace(/\s+/g, ' ');
    expect(text).toContain(`WHERE "status" = 'PUBLISHED' GROUP BY "studentId"`);
    expect(text).toContain(`LEFT JOIN totals AS t ON t."studentId" = s."id"`);    // no result → 0, not skipped
    expect(text).toContain(`s."role" = 'STUDENT'`);
    expect(text).toContain(`u."points" <> COALESCE(t.points, 0) OR u."problemsSolved" <> COALESCE(t.solved, 0)`);
    const lock = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, number];
    expect(lock[0].join('?')).toContain('pg_advisory_xact_lock');
    expect(lock[1]).toBe(4217);
  });

  it('runs in one transaction with a long enough timeout, and audits both counts', async () => {
    const { service, prisma, audit } = make(0, 12);
    await service.recomputeAllPoints(ADMIN);
    expect((prisma.$transaction.mock.calls[0] as unknown[])[1]).toEqual({ maxWait: 10_000, timeout: 120_000 });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'RECOMPUTE_POINTS', metadata: { students: 12, changed: 0 } }));
  });
});
