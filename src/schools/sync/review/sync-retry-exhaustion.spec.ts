/**
 * Retry exhaustion at the service level (S2b): recompare, apply and post-apply resolve each make
 * exactly three whole-transaction attempts on a transaction conflict, then answer 409 —
 * RECOMPARE_CONFLICT for recompare, SYNC_APPLY_CONFLICT for apply and resolve. A refused apply is
 * audited outside the (rolled-back) transaction.
 */
import { Prisma } from '../../../generated/prisma/client.js';
import { approvalKey, signApproval } from './approval-token.js';
import { SchoolSyncApplyService } from './school-sync-apply.service.js';
import { SchoolSyncReviewService } from './school-sync-review.service.js';

const SECRET = 'test-secret-that-is-long-enough-0123456789';
const conflict = () => new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `40001`. Message: `could not serialize access`', {
  code: 'P2010', clientVersion: 'test', meta: { driverAdapterError: Object.assign(new Error('x'), { name: 'DriverAdapterError', cause: { originalCode: '40001', originalMessage: 'x', kind: 'TransactionWriteConflict' } }) },
});
const caller = { id: 'sa-1', role: 'SUPER_ADMIN' } as never;
const config = { getOrThrow: () => SECRET, get: () => undefined } as never;

describe('sync retry exhaustion → 409', () => {
  it('recompare: 3 attempts, then 409 RECOMPARE_CONFLICT', async () => {
    const prisma = { $transaction: vi.fn(async () => { throw conflict(); }) };
    const review = new SchoolSyncReviewService(prisma as never, { log: vi.fn() } as never, { has: () => true } as never, config);
    await expect(review.recompare('run-1', caller)).rejects.toMatchObject({ status: 409, code: 'RECOMPARE_CONFLICT' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('apply: 3 attempts, then 409 SYNC_APPLY_CONFLICT (the refusal audited outside the transaction); resolve: the same', async () => {
    const prisma = { $transaction: vi.fn(async () => { throw conflict(); }) };
    const audit = { log: vi.fn(async () => undefined), logMany: vi.fn() };
    const apply = new SchoolSyncApplyService(prisma as never, audit as never, config);
    const token = signApproval(approvalKey(SECRET), { v: 1, run: 'run-1', file: 'f', report: 'r', decisions: 'd', gen: 1, jti: 't', sub: 'sa-1', exp: Date.now() + 60_000 });
    await expect(apply.apply('run-1', { token }, caller)).rejects.toMatchObject({ status: 409, code: 'SYNC_APPLY_CONFLICT' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'SCHOOL_SYNC_REFUSED', metadata: expect.objectContaining({ reason: 'SYNC_APPLY_CONFLICT' }) }));
    prisma.$transaction.mockClear();
    await expect(apply.resolveAfterApply('run-1', 'item-1', { schoolId: 's-1' }, caller)).rejects.toMatchObject({ status: 409, code: 'SYNC_APPLY_CONFLICT' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('any other error is not retried (one attempt, the error itself)', async () => {
    const unique = new Prisma.PrismaClientKnownRequestError('Raw query failed. Code: `23505`', {
      code: 'P2010', clientVersion: 'test', meta: { driverAdapterError: Object.assign(new Error('x'), { name: 'DriverAdapterError', cause: { originalCode: '23505', kind: 'UniqueConstraintViolation' } }) },
    });
    const prisma = { $transaction: vi.fn(async () => { throw unique; }) };
    const review = new SchoolSyncReviewService(prisma as never, { log: vi.fn() } as never, { has: () => true } as never, config);
    await expect(review.recompare('run-1', caller)).rejects.toBe(unique);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
