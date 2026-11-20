import {
  COACH_APPLICATION_ACTIONS, COACH_APPLICATION_MEMBERSHIP_TABLES, COACH_APPLICATION_SKIP_CODES, COACH_APPLICATION_TARGET, coachApplicationWarnings,
} from './coach-application-bulk.rules.js';

describe('COACH_APPLICATION bulk rules', () => {
  it("approve and reject need exactly the single routes' permission; the reason is optional as on PATCH …/reject", () => {
    expect(Object.keys(COACH_APPLICATION_ACTIONS)).toEqual(['approve', 'reject']);
    for (const a of ['approve', 'reject'] as const) expect(COACH_APPLICATION_ACTIONS[a]).toMatchObject({ permissions: ['mentorRequests.decide'], reason: 'optional' });
    expect(COACH_APPLICATION_TARGET).toEqual({ approve: 'APPROVED', reject: 'REJECTED' });
    expect([...COACH_APPLICATION_SKIP_CODES]).toEqual(['INVALID_STATE_TRANSITION']);
    expect([...COACH_APPLICATION_MEMBERSHIP_TABLES]).toEqual(['MentorRequest']);
  });

  it('preview warnings: decided applications skipped; approve warns that pictures are discarded', () => {
    const rows = [
      { status: 'PENDING', hasPicture: true }, { status: 'PENDING', hasPicture: false }, { status: 'APPROVED', hasPicture: false },
      { status: 'REJECTED', hasPicture: true },
    ];
    expect(coachApplicationWarnings('approve', rows).map((w) => [w.code, w.count])).toEqual([['ALREADY_IN_STATE', 1], ['ALREADY_DECIDED', 1], ['PICTURE_DISCARDED', 1]]);
    expect(coachApplicationWarnings('reject', rows).map((w) => [w.code, w.count])).toEqual([['ALREADY_IN_STATE', 1], ['ALREADY_DECIDED', 1]]);
  });
});
