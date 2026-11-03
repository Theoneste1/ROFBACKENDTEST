import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller.js';

function make({ db = true, storage = true } = {}) {
  const prisma  = { $queryRaw: vi.fn().mockImplementation(() => (db ? Promise.resolve([{ '?column?': 1 }]) : Promise.reject(new Error('db down')))) };
  const store   = { ping: vi.fn().mockImplementation(() => (storage ? Promise.resolve() : Promise.reject(new Error('bucket gone')))) };
  return new HealthController(prisma as any, store as any);
}

describe('HealthController', () => {
  it('reports ok when the database and storage respond', async () => {
    await expect(make().check()).resolves.toMatchObject({ status: 'ok', checks: { database: 'up', storage: 'up' } });
  });

  it.each([
    ['the database is down', { db: false }, { database: 'down', storage: 'up' }],
    ['storage is down', { storage: false }, { database: 'up', storage: 'down' }],
    ['both are down', { db: false, storage: false }, { database: 'down', storage: 'down' }],
  ])('answers 503 with the failing check when %s', async (_label, deps, checks) => {
    const err = await make(deps).check().catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ status: 'degraded', checks });
  });
});
