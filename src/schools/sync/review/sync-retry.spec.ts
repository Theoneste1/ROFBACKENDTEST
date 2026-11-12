import { Prisma } from '../../../generated/prisma/client.js';
import { approvalKey, checkApproval, signApproval, tokenSha256, type ApprovalClaims } from './approval-token.js';
import { isSerializationFailure, withSerializationRetry } from './sync-retry.js';

const p2034 = () => new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict or a deadlock', { code: 'P2034', clientVersion: 'test' });
const serialization = () => Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' });
const exhausted = () => new Error('EXHAUSTED');

describe('sync retry (S2b): whole transaction, 3 attempts, only P2034 / 40001', () => {
  it('recognises only serialization failures', () => {
    expect(isSerializationFailure(p2034())).toBe(true);
    expect(isSerializationFailure(serialization())).toBe(true);
    expect(isSerializationFailure(Object.assign(new Error('wrapped'), { cause: serialization() }))).toBe(true);
    for (const other of [new Error('boom'), Object.assign(new Error('unique'), { code: '23505' }), new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 't' })]) {
      expect(isSerializationFailure(other)).toBe(false);
    }
  });

  it('a fresh attempt for each serialization failure, at most 3, then the exhausted error; any other error at once', async () => {
    const calls: number[] = [];
    await expect(withSerializationRetry(async (n) => { calls.push(n); throw p2034(); }, exhausted, { backoffMs: () => 0 })).rejects.toThrow('EXHAUSTED');
    expect(calls).toEqual([1, 2, 3]);
    const other: number[] = [];
    await expect(withSerializationRetry(async (n) => { other.push(n); throw new Error('boom'); }, exhausted, { backoffMs: () => 0 })).rejects.toThrow('boom');
    expect(other).toEqual([1]);
    const second: number[] = [];
    await expect(withSerializationRetry(async (n) => { second.push(n); if (n === 1) throw serialization(); return 'ok'; }, exhausted, { backoffMs: () => 0 })).resolves.toBe('ok');
    expect(second).toEqual([1, 2]);
  });
});

describe('apply approval token (S2b)', () => {
  const key = approvalKey('test-secret-that-is-long-enough-0123456789');
  const claims: ApprovalClaims = { v: 1, run: 'run-1', file: 'f', report: 'r', decisions: 'd', gen: 3, jti: 'tok-1', sub: 'sa-1', exp: 2_000 };

  it('bound to the run and the approver; expires; tampering is detected; never stored — its SHA-256 identifies it', () => {
    const token = signApproval(key, claims);
    expect(checkApproval(key, token, { run: 'run-1', sub: 'sa-1', now: 1_000 })).toEqual({ ok: true, claims });
    expect(checkApproval(key, token, { run: 'run-2', sub: 'sa-1', now: 1_000 })).toEqual({ ok: false, reason: 'WRONG_RUN' });
    expect(checkApproval(key, token, { run: 'run-1', sub: 'sa-2', now: 1_000 })).toEqual({ ok: false, reason: 'WRONG_USER' });
    expect(checkApproval(key, token, { run: 'run-1', sub: 'sa-1', now: 2_000 })).toEqual({ ok: false, reason: 'EXPIRED' });
    const [body, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ ...claims, gen: 4 })).toString('base64url')}.${sig}`;
    expect(checkApproval(key, forged, { run: 'run-1', sub: 'sa-1', now: 1_000 })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(checkApproval(approvalKey('another-secret-0123456789-abcdefghij'), token, { run: 'run-1', sub: 'sa-1', now: 1_000 })).toEqual({ ok: false, reason: 'SIGNATURE' });
    expect(checkApproval(key, `${body}`, { run: 'run-1', sub: 'sa-1', now: 1_000 })).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(tokenSha256(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenSha256(token)).not.toContain(body);
  });
});

/**
 * The exact shape Prisma 7 + @prisma/adapter-pg produce for a raw query (verified by raising each
 * SQLSTATE through the real client and adapter): P2010 with the adapter error in meta.
 */
const rawQueryError = (originalCode: string, kind: string) => new Prisma.PrismaClientKnownRequestError(
  `Raw query failed. Code: \`${originalCode}\`. Message: \`probe\``,
  { code: 'P2010', clientVersion: 'test', meta: { driverAdapterError: Object.assign(new Error('probe'), { name: 'DriverAdapterError', cause: { originalCode, originalMessage: 'probe', kind } }) } },
);

describe('sync retry — Prisma 7 adapter errors for raw queries (P2010)', () => {
  it('retries P2010 only for the adapter\'s TransactionWriteConflict (40001, 40P01) — never another P2010', () => {
    expect(isSerializationFailure(rawQueryError('40001', 'TransactionWriteConflict'))).toBe(true);
    expect(isSerializationFailure(rawQueryError('40P01', 'TransactionWriteConflict'))).toBe(true);
    expect(isSerializationFailure(rawQueryError('23505', 'UniqueConstraintViolation'))).toBe(false);
    expect(isSerializationFailure(rawQueryError('40001', 'postgres'))).toBe(false);                    // the code alone is not enough
    expect(isSerializationFailure(rawQueryError('23505', 'TransactionWriteConflict'))).toBe(false);    // nor the kind alone
    expect(isSerializationFailure(rawQueryError('P0001', 'postgres'))).toBe(false);                    // a trigger's exception
    expect(isSerializationFailure(new Prisma.PrismaClientKnownRequestError('Raw query failed', { code: 'P2010', clientVersion: 't' }))).toBe(false);
    // Unchanged: P2034 and a direct 40001.
    expect(isSerializationFailure(p2034())).toBe(true);
    expect(isSerializationFailure(serialization())).toBe(true);
  });

  it('a P2010 40001 is retried up to 3 attempts; a P2010 23505 is thrown at once', async () => {
    const calls: number[] = [];
    await expect(withSerializationRetry(async (n) => { calls.push(n); throw rawQueryError('40001', 'TransactionWriteConflict'); }, exhausted, { backoffMs: () => 0 })).rejects.toThrow('EXHAUSTED');
    expect(calls).toEqual([1, 2, 3]);
    const unique: number[] = [];
    await expect(withSerializationRetry(async (n) => { unique.push(n); throw rawQueryError('23505', 'UniqueConstraintViolation'); }, exhausted, { backoffMs: () => 0 })).rejects.toMatchObject({ code: 'P2010' });
    expect(unique).toEqual([1]);
  });
});
