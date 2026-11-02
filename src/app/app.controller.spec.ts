import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';

describe('AppController', () => {
  const controller = new AppController(new AppService());

  it('getInfo returns the API description', () => {
    expect(controller.getInfo()).toEqual({
      name:    'ROF LMS API',
      version: '1.0.0',
      docs:    '/api/docs',
      health:  '/health',
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
});
