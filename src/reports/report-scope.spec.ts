import { ReportScopeService } from './report-scope.js';

describe('ReportScopeService.resolve', () => {
  const service = new ReportScopeService({} as any, { get: () => undefined } as any, {} as any);
  const admin = { id: 'a1', role: 'ADMIN' } as any;

  it('rejects a filter the report cannot apply instead of ignoring it (FILTER_NOT_SUPPORTED)', async () => {
    await expect(service.resolve({ courseId: '00000000-0000-0000-0000-000000000001' }, admin, { unsupported: ['courseId'] }))
      .rejects.toMatchObject({ code: 'FILTER_NOT_SUPPORTED', status: 400 });
  });
});
