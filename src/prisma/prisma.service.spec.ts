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
