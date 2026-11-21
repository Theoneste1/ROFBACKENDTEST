import { SCHOOL_ACTIONS, SCHOOL_BULK_ACTIONS, SCHOOL_MEMBERSHIP_TABLES, SCHOOL_SKIP_CODES, schoolAlreadyDone, schoolWarnings } from './school-bulk.rules.js';

const s = (isActive: boolean, countryCode = 'RW', lastVerifiedAt: Date | null = null) => ({ isActive, countryCode, lastVerifiedAt });

describe('SCHOOL bulk rules', () => {
  it("every action needs exactly the single routes' permission (schools.manage); activate / deactivate need a reason like PATCH /admin/schools/:id/active", () => {
    expect(Object.keys(SCHOOL_ACTIONS)).toEqual([...SCHOOL_BULK_ACTIONS]);
    for (const a of SCHOOL_BULK_ACTIONS) expect(SCHOOL_ACTIONS[a].permissions).toEqual(['schools.manage']);
    expect(SCHOOL_ACTIONS.activate.reason).toBe('required');
    expect(SCHOOL_ACTIONS.deactivate.reason).toBe('required');
    expect(SCHOOL_ACTIONS.verify.reason).toBe('optional');
  });

  it('guards the tables GET /admin/schools filters read; verification refusals are failures, not skips', () => {
    expect([...SCHOOL_MEMBERSHIP_TABLES].sort()).toEqual(['School', 'SchoolEducationLevel', 'SchoolProgramme', 'SchoolSourceRecord']);
    expect(SCHOOL_SKIP_CODES.has('SCHOOL_INACTIVE')).toBe(false);
    expect(SCHOOL_SKIP_CODES.has('SCHOOL_DIRECTORY_RWANDA_ONLY')).toBe(false);
  });

  it('already done: active for activate, inactive for deactivate, verified for verify', () => {
    expect(schoolAlreadyDone('activate', s(true))).toBe(true);
    expect(schoolAlreadyDone('activate', s(false))).toBe(false);
    expect(schoolAlreadyDone('deactivate', s(false))).toBe(true);
    expect(schoolAlreadyDone('deactivate', s(true))).toBe(false);
    expect(schoolAlreadyDone('verify', s(true, 'RW', new Date()))).toBe(true);
    expect(schoolAlreadyDone('verify', s(true))).toBe(false);
  });

  it('preview warnings count what will be skipped and (verify) what will fail', () => {
    const rows = [s(true), s(true), s(false), s(false, 'KE'), s(true, 'KE'), s(true, 'RW', new Date())];
    expect(schoolWarnings('activate', rows)).toEqual([expect.objectContaining({ code: 'ALREADY_IN_STATE', count: 4 })]);
    expect(schoolWarnings('deactivate', rows)).toEqual([expect.objectContaining({ code: 'ALREADY_IN_STATE', count: 2 })]);
    expect(schoolWarnings('verify', rows).map((w) => [w.code, w.count])).toEqual([
      ['ALREADY_IN_STATE', 1], ['SCHOOL_INACTIVE', 2], ['SCHOOL_DIRECTORY_RWANDA_ONLY', 1],
    ]);
    expect(schoolWarnings('activate', [s(false)])).toEqual([]);
  });
});
