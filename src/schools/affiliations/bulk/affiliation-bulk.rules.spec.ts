import { AFFILIATION_ACTIONS, AFFILIATION_MEMBERSHIP_TABLES, AFFILIATION_SKIP_CODES, AFFILIATION_TARGET, affiliationWarnings } from './affiliation-bulk.rules.js';

const c = (status: string, o: { current?: boolean; hasSchool?: boolean; schoolActive?: boolean | null } = {}) =>
  ({ status, current: o.current ?? true, hasSchool: o.hasSchool ?? true, schoolActive: o.schoolActive === undefined ? true : o.schoolActive });

describe('SCHOOL_AFFILIATION bulk rules', () => {
  it("verify and reject need exactly the single routes' permission; reject needs a reason (shown to the student)", () => {
    expect(Object.keys(AFFILIATION_ACTIONS)).toEqual(['verify', 'reject']);
    expect(AFFILIATION_ACTIONS.verify).toMatchObject({ permissions: ['schools.manage'], reason: 'optional' });
    expect(AFFILIATION_ACTIONS.reject).toMatchObject({ permissions: ['schools.manage'], reason: 'required' });
    expect(AFFILIATION_TARGET).toEqual({ verify: 'VERIFIED', reject: 'REJECTED' });
  });

  it('a replaced or concurrently decided claim is skipped; a missing or inactive school fails', () => {
    expect([...AFFILIATION_SKIP_CODES].sort()).toEqual(['AFFILIATION_STATUS_CONFLICT', 'AFFILIATION_SUPERSEDED']);
    expect(AFFILIATION_SKIP_CODES.has('AFFILIATION_SCHOOL_REQUIRED')).toBe(false);
    expect(AFFILIATION_SKIP_CODES.has('SCHOOL_INACTIVE')).toBe(false);
    expect([...AFFILIATION_MEMBERSHIP_TABLES]).toEqual(['StudentSchoolAffiliation']);
  });

  it('preview warnings', () => {
    const rows = [
      c('PENDING'), c('PENDING', { hasSchool: false, schoolActive: null }), c('PENDING', { schoolActive: false }),
      c('VERIFIED'), c('REJECTED'), c('PENDING', { current: false }),
    ];
    expect(affiliationWarnings('verify', rows).map((w) => [w.code, w.count])).toEqual([
      ['AFFILIATION_SUPERSEDED', 1], ['ALREADY_IN_STATE', 1], ['NOT_APPLICABLE', 1], ['AFFILIATION_SCHOOL_REQUIRED', 1], ['SCHOOL_INACTIVE', 1],
    ]);
    expect(affiliationWarnings('reject', rows).map((w) => [w.code, w.count])).toEqual([
      ['AFFILIATION_SUPERSEDED', 1], ['ALREADY_IN_STATE', 1], ['NOT_APPLICABLE', 1],
    ]);
    expect(affiliationWarnings('reject', [c('PENDING')])).toEqual([]);
  });
});
