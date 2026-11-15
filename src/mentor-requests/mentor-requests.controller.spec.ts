import { Reflector } from '@nestjs/core';
import { MentorRequestsController } from './mentor-requests.controller.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { legacyRolesFor } from '../auth/route-access.testing.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';

const reflector = new Reflector();

function effective(method: string, key: string) {
  const handler = (MentorRequestsController.prototype as unknown as Record<string, Function>)[method];
  return reflector.getAllAndOverride(key, [handler, MentorRequestsController]);
}

describe('MentorRequestsController authorization metadata', () => {
  it('has no class-level roles', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MentorRequestsController)).toBeUndefined();
  });

  it('create is public (anyone can apply to become a mentor)', () => {
    expect(effective('create', IS_PUBLIC_KEY)).toBe(true);
    expect(legacyRolesFor(MentorRequestsController, 'create')).toBeUndefined();
  });

  it.each(['findAll', 'approve', 'reject'])('%s is ADMIN only and not public', (method) => {
    expect(legacyRolesFor(MentorRequestsController, method)).toEqual(['ADMIN']);
    expect(effective(method, IS_PUBLIC_KEY)).toBeUndefined();
  });
});
