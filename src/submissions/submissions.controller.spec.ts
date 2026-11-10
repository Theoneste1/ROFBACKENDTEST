import { Reflector } from '@nestjs/core';
import {
  AdminPointsController,
  AssignmentResultsController,
  MentorReviewsController,
  MySubmissionsController,
  SubmissionsController,
} from './submissions.controller.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
import { legacyRolesFor, requiredPermission } from '../auth/route-access.testing.js';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator.js';

const reflector = new Reflector();

function effective(cls: Function, method: string, key: string) {
  const handler = (cls.prototype as Record<string, Function>)[method];
  return reflector.getAllAndOverride(key, [handler, cls]);
}

function methodsOf(cls: Function) {
  return Object.getOwnPropertyNames(cls.prototype).filter((m) => m !== 'constructor');
}

describe('SubmissionsController authorization metadata', () => {
  it('has no class-level roles', () => {
    expect(Reflect.getMetadata(ROLES_KEY, SubmissionsController)).toBeUndefined();
  });

  it('submit is STUDENT only', () => {
    expect(legacyRolesFor(SubmissionsController, 'submit')).toEqual(['STUDENT']);
  });

  it.each(['startReview', 'mark', 'submitToAdmin'])(
    '%s is MENTOR only (admins must not grade)',
    (method) => {
      const roles = legacyRolesFor(SubmissionsController, method) as string[];
      expect(roles).toEqual(['MENTOR']);
      expect(roles).not.toContain('ADMIN');
    },
  );

  it.each(['findAll', 'assign', 'reassign', 'approve', 'reject', 'publish', 'reopen'])(
    '%s is ADMIN only',
    (method) => {
      expect(legacyRolesFor(SubmissionsController, method)).toEqual(['ADMIN']);
    },
  );

  it.each(['findOne', 'file', 'revisionFile', 'feedbackFile'])(
    '%s is open to any authenticated role (the service checks ownership)',
    (method) => {
      expect(legacyRolesFor(SubmissionsController, method)).toBeUndefined();
    },
  );

  it('exposes no public routes', () => {
    for (const method of methodsOf(SubmissionsController)) {
      expect(effective(SubmissionsController, method, IS_PUBLIC_KEY)).toBeUndefined();
    }
  });
});

describe.each([
  { name: 'AssignmentResultsController', cls: AssignmentResultsController, expected: ['ADMIN'] },
  { name: 'MySubmissionsController',     cls: MySubmissionsController,     expected: ['STUDENT'] },
  { name: 'MentorReviewsController',     cls: MentorReviewsController,     expected: ['MENTOR'] },
  { name: 'AdminPointsController',       cls: AdminPointsController,       expected: ['ADMIN'] },
])('$name authorization metadata', ({ cls, expected }) => {
  it(`is ${expected.join(',')} — by class-level @Roles, or (converted, P1-06) by a permission on every handler`, () => {
    const classRoles = Reflect.getMetadata(ROLES_KEY, cls);
    if (classRoles !== undefined) expect(classRoles).toEqual(expected);
    else for (const m of methodsOf(cls)) expect([m, requiredPermission(cls, m) !== undefined]).toEqual([m, true]);
  });

  it('every handler resolves to the class roles and none is public', () => {
    const methods = methodsOf(cls);
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(legacyRolesFor(cls, method)).toEqual(expected);
      expect(effective(cls, method, IS_PUBLIC_KEY)).toBeUndefined();
    }
  });
});
