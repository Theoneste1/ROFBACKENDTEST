import { ConfigService } from '@nestjs/config';
import { capabilitiesOf } from '../src/app/capabilities.js';
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

  it('GET /api/v1: legacy fields unchanged, plus the capabilities of the running configuration (public, stable)', async () => {
    const res = await ctx.http().get('/api/v1').expect(200);
    expect(Object.keys(res.body)).toEqual(['name', 'version', 'docs', 'health', 'capabilities']);
    expect(res.body).toMatchObject({ name: 'ROF LMS API', version: '1.0.0', docs: '/api/docs', health: '/health' });
    const config = ctx.app.get(ConfigService);
    expect(res.body.capabilities).toEqual(capabilitiesOf(config));
    // Exactly the approved V1 features for this configuration — never the directory sync.
    expect(res.body.capabilities.features).toEqual([
      'academicYearActivation',
      ...(config.get('HEAD_COACHES_ENABLED') === 'true' ? ['headCoachAccounts'] : []),
      'permissionScopes', 'reviewQueueFilters', 'schoolAdministration', 'schoolAffiliations', 'schoolReferenceRequired',
      ...(config.get('TEACHERS_ENABLED') === 'true' ? ['teacherAccounts'] : []),
    ]);
    expect(res.body.capabilities.features).not.toContain('schoolDirectorySync');
    const again = await ctx.http().get('/api/v1').expect(200);
    expect(again.body).toEqual(res.body);
  });

  it('GET /api/v1 is sent with Cache-Control: no-store; other routes keep their caching behaviour', async () => {
    const res = await ctx.http().get('/api/v1').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect((await ctx.http().get('/health').expect(200)).headers['cache-control']).toBeUndefined();
    expect((await ctx.http().get('/api/v1/courses').expect(401)).headers['cache-control']).toBeUndefined();
  });

  it('every always-available feature refers to routes this build registers (401 without a token, never 404)', async () => {
    const routes: Array<[string, string]> = [
      ['get', '/api/v1/me/permissions'],                 // permissionScopes
      ['post', '/api/v1/admin/users/invite'],            // schoolReferenceRequired
      ['post', '/api/v1/admin/users/import'],
      ['get', '/api/v1/admin/schools'],                  // schoolAdministration
      ['get', '/api/v1/me/school-affiliation'],          // schoolAffiliations
      ['get', '/api/v1/admin/school-affiliations'],
    ];
    for (const [method, path] of routes) {
      const res = method === 'get' ? await ctx.http().get(path) : await ctx.http().post(path).send({});
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it('the directory sync is not advertised but its routes are unchanged (still registered and protected)', async () => {
    expect((await ctx.http().get('/api/v1').expect(200)).body.capabilities.features).not.toContain('schoolDirectorySync');
    expect((await ctx.http().get('/api/v1/admin/school-sync/runs')).status).toBe(401);
    expect((await ctx.http().post('/api/v1/admin/school-sync/runs/x/apply').send({})).status).toBe(401);
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
