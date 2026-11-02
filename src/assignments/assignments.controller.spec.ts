import { Reflector } from '@nestjs/core';
import { AssignmentsController, MyAssignmentsController } from './assignments.controller.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';

const reflector = new Reflector();

function effective(cls: Function, method: string, key: string) {
  const handler = (cls.prototype as Record<string, Function>)[method];
  return reflector.getAllAndOverride(key, [handler, cls]);
}

describe('AssignmentsController authorization metadata', () => {
  it('has no class-level roles', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AssignmentsController)).toBeUndefined();
  });

  it.each(['create', 'update', 'submitForReview', 'recall'])(
    '%s is MENTOR only (admins never author assignments)',
    (method) => {
      expect(effective(AssignmentsController, method, ROLES_KEY)).toEqual(['MENTOR']);
    },
  );

  it.each(['publish', 'reject', 'unpublish'])('%s is ADMIN only', (method) => {
    expect(effective(AssignmentsController, method, ROLES_KEY)).toEqual(['ADMIN']);
  });

  it.each(['findAll', 'findOne', 'download'])('%s is open to any authenticated role', (method) => {
    expect(effective(AssignmentsController, method, ROLES_KEY)).toBeUndefined();
  });

  it('exposes no public routes', () => {
    for (const method of Object.getOwnPropertyNames(AssignmentsController.prototype)) {
      if (method === 'constructor') continue;
      expect(effective(AssignmentsController, method, IS_PUBLIC_KEY)).toBeUndefined();
    }
  });
});

describe('MyAssignmentsController authorization metadata', () => {
  it('is STUDENT only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, MyAssignmentsController)).toEqual(['STUDENT']);
    expect(effective(MyAssignmentsController, 'findMine', ROLES_KEY)).toEqual(['STUDENT']);
  });
});
