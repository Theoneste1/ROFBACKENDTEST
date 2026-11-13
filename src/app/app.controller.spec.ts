import { HEADERS_METADATA } from '@nestjs/common/constants.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';

describe('AppController', () => {
  const controller = new AppController(new AppService({ get: () => undefined } as never));

  it('getInfo returns the API description (legacy fields unchanged) with its capabilities', () => {
    expect(controller.getInfo()).toEqual({
      name:    'ROF LMS API',
      version: '1.0.0',
      docs:    '/api/docs',
      health:  '/health',
      capabilities: {
        schemaVersion: 1,
        roles: ['STUDENT', 'TEACHER', 'MENTOR', 'HEAD_COACH', 'ADMIN', 'SUPER_ADMIN'],
        features: ['academicYearActivation', 'permissionScopes', 'schoolAdministration', 'schoolAffiliations', 'schoolReferenceRequired'],
      },
    });
  });

  it('getInfo delegates to AppService', () => {
    const service = { getInfo: vi.fn().mockReturnValue({ name: 'x' }) };
    const c = new AppController(service as unknown as AppService);
    expect(c.getInfo()).toEqual({ name: 'x' });
    expect(service.getInfo).toHaveBeenCalledOnce();
  });

  it('getInfo is public', () => {
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AppController.prototype.getInfo)).toBe(true);
  });

  it('getInfo sends exactly one response header of its own: Cache-Control: no-store', () => {
    expect(Reflect.getMetadata(HEADERS_METADATA, AppController.prototype.getInfo)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
  });
});
