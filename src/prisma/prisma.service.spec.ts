import { transactionMaxWaitMs } from './prisma.service.js';

describe('transactionMaxWaitMs', () => {
  it('defaults to 10 s and stays between 2 s (Prisma default) and 20 s (below the proxy limit)', () => {
    expect(transactionMaxWaitMs(undefined)).toBe(10_000);
    expect(transactionMaxWaitMs('5000')).toBe(5_000);
    expect(transactionMaxWaitMs('500')).toBe(2_000);
    expect(transactionMaxWaitMs('60000')).toBe(20_000);
    expect(transactionMaxWaitMs('abc')).toBe(10_000);
  });
});

describe('queryEventsEnabled (test-only instrumentation)', () => {
  it('is on only for exactly "true" (never by default)', async () => {
    const { queryEventsEnabled } = await import('./prisma.service.js');
    expect([undefined, '', '1', 'TRUE', 'false', 'true'].map((v) => queryEventsEnabled(v))).toEqual([false, false, false, false, false, true]);
  });
});
