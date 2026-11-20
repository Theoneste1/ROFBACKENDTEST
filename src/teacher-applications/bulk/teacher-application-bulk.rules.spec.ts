import {
  TEACHER_APPLICATION_ACTIONS, TEACHER_APPLICATION_MEMBERSHIP_TABLES, TEACHER_APPLICATION_SKIP_CODES, teacherApplicationWarnings,
} from './teacher-application-bulk.rules.js';

describe('TEACHER_APPLICATION bulk rules', () => {
  it('only reject — never a bulk approve (an approval needs a per-application school decision)', () => {
    expect(Object.keys(TEACHER_APPLICATION_ACTIONS)).toEqual(['reject']);
    expect(Object.hasOwn(TEACHER_APPLICATION_ACTIONS, 'approve')).toBe(false);
  });

  it("reject needs the single route's permission and a reason; 'already decided' is a skip", () => {
    expect(TEACHER_APPLICATION_ACTIONS.reject).toMatchObject({ permissions: ['users.manageTeachers'], reason: 'required' });
    expect([...TEACHER_APPLICATION_SKIP_CODES]).toEqual(['APPLICATION_ALREADY_DECIDED']);
    expect([...TEACHER_APPLICATION_MEMBERSHIP_TABLES]).toEqual(['TeacherApplication']);
  });

  it('preview warnings: rejected and approved applications are skipped', () => {
    expect(teacherApplicationWarnings(['PENDING', 'REJECTED', 'APPROVED', 'APPROVED']).map((w) => [w.code, w.count]))
      .toEqual([['ALREADY_IN_STATE', 1], ['ALREADY_DECIDED', 2]]);
    expect(teacherApplicationWarnings(['PENDING'])).toEqual([]);
  });
});
