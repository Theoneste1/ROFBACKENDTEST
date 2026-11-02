import { Reflector } from '@nestjs/core';
import {
  AdminPointsController,
  AssignmentResultsController,
  MentorReviewsController,
  MySubmissionsController,
  SubmissionsController,
} from './submissions.controller.js';
import { ROLES_KEY } from '../auth/decorators/roles.decorator.js';
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
    expect(effective(SubmissionsController, 'submit', ROLES_KEY)).toEqual(['STUDENT']);
  });

  it.each(['startReview', 'mark', 'submitToAdmin'])(
    '%s is MENTOR only (admins must not grade)',
    (method) => {
      const roles = effective(SubmissionsController, method, ROLES_KEY) as string[];
      expect(roles).toEqual(['MENTOR']);
      expect(roles).not.toContain('ADMIN');
    },
  );

  it.each(['findAll', 'assign', 'reassign', 'approve', 'reject', 'publish', 'reopen'])(
    '%s is ADMIN only',
    (method) => {
      expect(effective(SubmissionsController, method, ROLES_KEY)).toEqual(['ADMIN']);
    },
  );

  it.each(['findOne', 'file', 'revisionFile', 'feedbackFile'])(
    '%s is open to any authenticated role (the service checks ownership)',
    (method) => {
      expect(effective(SubmissionsController, method, ROLES_KEY)).toBeUndefined();
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
  it(`is ${expected.join(',')} at class level`, () => {
    expect(Reflect.getMetadata(ROLES_KEY, cls)).toEqual(expected);
  });

  it('every handler resolves to the class roles and none is public', () => {
    const methods = methodsOf(cls);
    expect(methods.length).toBeGreaterThan(0);
    for (const method of methods) {
      expect(effective(cls, method, ROLES_KEY)).toEqual(expected);
      expect(effective(cls, method, IS_PUBLIC_KEY)).toBeUndefined();
    }
  });
});
