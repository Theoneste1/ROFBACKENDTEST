import { delegationCovers } from './teacher-scope.js';

const school = { id: 's1', viaSchool: true, viaAssignment: false };
const assigned = { id: 's2', viaSchool: false, viaAssignment: true };
const both = { id: 's3', viaSchool: true, viaAssignment: true };
const hidden = { id: 's4', viaSchool: false, viaAssignment: false };

describe('delegationCovers (TS-4)', () => {
  it('SCHOOL covers students seen through the schools only', () => {
    const g = [{ studentScope: 'SCHOOL' as const, selected: [] }];
    expect([school, assigned, both, hidden].map((s) => delegationCovers(g, s))).toEqual([true, false, true, false]);
  });
  it('ASSIGNED covers explicitly assigned students only', () => {
    const g = [{ studentScope: 'ASSIGNED' as const, selected: [] }];
    expect([school, assigned, both, hidden].map((s) => delegationCovers(g, s))).toEqual([false, true, true, false]);
  });
  it('SELECTED covers listed students that are still visible', () => {
    const g = [{ studentScope: 'SELECTED' as const, selected: ['s1', 's4'] }];
    expect([school, assigned, both, hidden].map((s) => delegationCovers(g, s))).toEqual([true, false, false, false]);
  });
  it('a grant without a scope (older row) behaves as SCHOOL; several grants combine', () => {
    expect(delegationCovers([{ studentScope: null, selected: [] }], school)).toBe(true);
    expect(delegationCovers([{ studentScope: null, selected: [] }], assigned)).toBe(false);
    expect(delegationCovers([{ studentScope: 'SCHOOL', selected: [] }, { studentScope: 'SELECTED', selected: ['s2'] }], assigned)).toBe(true);
  });
  it('no grant covers nothing', () => {
    expect(delegationCovers([], both)).toBe(false);
  });
});
