import { DistributionStrategy } from './submissions.constants.js';

/**
 * Which coach reviews each pending submission (in the given order):
 *   ROUND_ROBIN → coaches in turn, in the order given;
 *   BALANCED    → the coach with the fewest open reviews at that moment (counting the ones
 *                 already planned in this run); ties go to the earlier coach in the order given.
 * `loads` (open reviews per coach) is updated as submissions are planned.
 */
export function planDistribution(
  submissionIds: string[], mentorIds: string[], loads: Map<string, number>, strategy: DistributionStrategy | string,
): Array<{ submissionId: string; mentorId: string }> {
  const plan: Array<{ submissionId: string; mentorId: string }> = [];
  let turn = 0;
  for (const submissionId of submissionIds) {
    let mentorId: string;
    if (strategy === DistributionStrategy.ROUND_ROBIN) {
      mentorId = mentorIds[turn++ % mentorIds.length];
    } else {
      mentorId = mentorIds[0];
      for (const id of mentorIds) if ((loads.get(id) ?? 0) < (loads.get(mentorId) ?? 0)) mentorId = id;
    }
    loads.set(mentorId, (loads.get(mentorId) ?? 0) + 1);
    plan.push({ submissionId, mentorId });
  }
  return plan;
}
