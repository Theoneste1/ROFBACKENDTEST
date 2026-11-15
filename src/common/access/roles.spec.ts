import { HttpStatus } from '@nestjs/common';

import { AppError } from '../errors/app-error.js';
import { isAdmin, isCoach, isStaff, isStudent, unsupportedRole } from './roles.js';

const caller = (role: unknown) => ({ role }) as { role: string };

describe('positive role helpers', () => {
  it.each([
    ['ADMIN',   { isAdmin: true,  isCoach: false, isStudent: false, isStaff: true }],
    ['SUPER_ADMIN', { isAdmin: true, isCoach: false, isStudent: false, isStaff: true }],
    ['MENTOR',  { isAdmin: false, isCoach: true,  isStudent: false, isStaff: true }],
    ['STUDENT', { isAdmin: false, isCoach: false, isStudent: true,  isStaff: false }],
  ])('%s', (role, expected) => {
    const u = caller(role);
    expect({ isAdmin: isAdmin(u), isCoach: isCoach(u), isStudent: isStudent(u), isStaff: isStaff(u) }).toEqual(expected);
  });

  // SUPER_ADMIN is an administrator since P1-08 (table above); TEACHER and HEAD_COACH stay unsupported here.
  it.each(['UNKNOWN_ROLE', 'TEACHER', 'HEAD_COACH', 'super_admin', 'admin', 'Admin', '', undefined, null])(
    'an unsupported role (%o) matches no helper — in particular it is never staff',
    (role) => {
      const u = caller(role);
      expect([isAdmin(u), isCoach(u), isStudent(u), isStaff(u)]).toEqual([false, false, false, false]);
    },
  );

  it('unsupportedRole() is a 403 with code ROLE_NOT_SUPPORTED', () => {
    const err = unsupportedRole();
    expect(err).toBeInstanceOf(AppError);
    expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(err.code).toBe('ROLE_NOT_SUPPORTED');
  });
});
