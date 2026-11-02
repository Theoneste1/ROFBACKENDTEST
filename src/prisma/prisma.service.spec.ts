import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  const original = process.env.DATABASE_URL;

  beforeAll(() => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/unit_test_dummy';
  });

  afterAll(() => {
    process.env.DATABASE_URL = original;
  });

  // Assertions stay on primitives: the Prisma client is a Proxy that neither
  // `instanceof` nor the matcher's object formatter handles well.
  it('constructs without connecting to the database', () => {
    const service = new PrismaService();
    expect(typeof service.$connect).toBe('function');
    expect(typeof service.onModuleInit).toBe('function');
    expect(typeof service.onModuleDestroy).toBe('function');
  });
});
