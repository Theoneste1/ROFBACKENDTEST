import { planDistribution } from './distribution-plan.js';

describe('planDistribution', () => {
  it('ROUND_ROBIN deals coaches in turn, in the order given', () => {
    const plan = planDistribution(['a', 'b', 'c', 'd', 'e'], ['m1', 'm2', 'm3'], new Map(), 'ROUND_ROBIN');
    expect(plan.map((p) => p.mentorId)).toEqual(['m1', 'm2', 'm3', 'm1', 'm2']);
    expect(plan.map((p) => p.submissionId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('BALANCED gives each submission to the least-loaded coach, counting this run; ties to the earlier coach', () => {
    const loads = new Map([['m1', 3], ['m2', 0], ['m3', 1]]);
    const plan = planDistribution(['a', 'b', 'c', 'd', 'e'], ['m1', 'm2', 'm3'], loads, 'BALANCED');
    // m2 (0) first; at equal load the earlier coach wins, until all three reach 3.
    expect(plan.map((p) => p.mentorId)).toEqual(['m2', 'm2', 'm3', 'm2', 'm3']);
    expect([...loads.values()]).toEqual([3, 3, 3]);
  });

  it('BALANCED matches the former sort-based choice (stable sort by load, first wins)', () => {
    const mentors = ['m1', 'm2', 'm3', 'm4'];
    const start = [5, 2, 2, 7];
    const a = new Map(mentors.map((m, i) => [m, start[i]]));
    const b = new Map(mentors.map((m, i) => [m, start[i]]));
    const ids = Array.from({ length: 40 }, (_, i) => `s${i}`);
    const expected = ids.map(() => {
      const m = [...b.entries()].sort((x, y) => x[1] - y[1])[0][0];
      b.set(m, b.get(m)! + 1);
      return m;
    });
    expect(planDistribution(ids, mentors, a, 'BALANCED').map((p) => p.mentorId)).toEqual(expected);
  });
});
