import { PERMISSIONS, ROLE_PERMISSIONS, permissionsFor, type Permission } from './permissions.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';
import { AssignmentResultsController, SubmissionsController } from '../submissions/submissions.controller.js';
import { AssignmentsController } from '../assignments/assignments.controller.js';

const ROLES = Object.keys(ROLE_PERMISSIONS) as Array<keyof typeof ROLE_PERMISSIONS>;

/** Every role that holds the permission, in a stable order. */
const holders = (permission: Permission) =>
  ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(permission)).sort();

const methodRoles = (cls: Function, method: string): string[] | undefined =>
  Reflect.getMetadata(ROLES_KEY, (cls.prototype as Record<string, Function>)[method]);

describe('permissions', () => {
  it('defines permissions for exactly STUDENT, MENTOR and ADMIN', () => {
    expect([...ROLES].sort()).toEqual(['ADMIN', 'MENTOR', 'STUDENT']);
  });

  it.each(ROLES)('every %s permission is a known permission, listed once', (role) => {
    const perms = ROLE_PERMISSIONS[role];
    for (const p of perms) expect(PERMISSIONS).toContain(p);
    expect(new Set(perms).size).toBe(perms.length);
  });

  it('PERMISSIONS has no duplicates', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('administrators never grade; mentors do', () => {
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('reviews.grade');
    expect(ROLE_PERMISSIONS.MENTOR).toContain('reviews.grade');
    expect(holders('reviews.grade')).toEqual(['MENTOR']);
  });

  it('only students submit work', () => {
    expect(ROLE_PERMISSIONS.STUDENT).toContain('submissions.submit');
    expect(holders('submissions.submit')).toEqual(['STUDENT']);
  });

  it('permissionsFor returns the role map (and nothing for an unknown role)', () => {
    expect(permissionsFor('MENTOR')).toBe(ROLE_PERMISSIONS.MENTOR);
    expect(permissionsFor('NOBODY' as any)).toEqual([]);
  });

  describe('consistency with route @Roles metadata', () => {
    it.each(['startReview', 'mark', 'submitToAdmin'])(
      'SubmissionsController.%s is limited to holders of reviews.grade',
      (method) => {
        expect(methodRoles(SubmissionsController, method)).toEqual(['MENTOR']);
        expect(methodRoles(SubmissionsController, method)).toEqual(holders('reviews.grade'));
      },
    );

    it('SubmissionsController.submit is limited to holders of submissions.submit', () => {
      expect(methodRoles(SubmissionsController, 'submit')).toEqual(holders('submissions.submit'));
    });

    it('AssignmentsController.publish is limited to holders of assignments.publish', () => {
      expect(methodRoles(AssignmentsController, 'publish')).toEqual(['ADMIN']);
      expect(methodRoles(AssignmentsController, 'publish')).toEqual(holders('assignments.publish'));
    });

    it('AssignmentResultsController (distribute / publish results) is limited to holders of submissions.distribute and results.publish', () => {
      const roles = Reflect.getMetadata(ROLES_KEY, AssignmentResultsController);
      expect(roles).toEqual(['ADMIN']);
      expect(roles).toEqual(holders('submissions.distribute'));
      expect(roles).toEqual(holders('results.publish'));
      // No method-level override widens access.
      for (const m of ['distribute', 'publishResults']) {
        expect(methodRoles(AssignmentResultsController, m)).toBeUndefined();
      }
    });
  });
});
