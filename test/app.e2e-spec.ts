import { createTestApp, type TestContext } from './helpers.js';

describe('App basics (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.app.close();
  });

  it('GET /health reports database and storage', async () => {
    const res = await ctx.http().get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { database: 'up', storage: 'up' } });
  });

  it('GET /api/v1 returns API info', async () => {
    const res = await ctx.http().get('/api/v1').expect(200);
    expect(res.body.name).toBe('ROF LMS API');
  });

  it('protected routes require a token, with the standard error shape', async () => {
    const res = await ctx.http().get('/api/v1/courses').expect(401);
    expect(res.body).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED' });
    expect(res.body.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('sets security headers', async () => {
    const res = await ctx.http().get('/api/v1');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects unknown body fields', async () => {
    const res = await ctx.http().post('/api/v1/auth/login')
      .send({ username: 'admin', password: 'x', isAdmin: true }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
