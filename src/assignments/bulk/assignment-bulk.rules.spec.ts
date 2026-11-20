import {
  ASSIGNMENT_ACTIONS, ASSIGNMENT_BULK_ACTIONS, ASSIGNMENT_FROM, ASSIGNMENT_MEMBERSHIP_TABLES, ASSIGNMENT_SKIP_CODES, ASSIGNMENT_TARGET,
  assignmentWarnings,
} from './assignment-bulk.rules.js';

const NOW = new Date('2026-11-20T12:00:00Z');
const FUTURE = new Date('2026-12-20T12:00:00Z');
const PAST = new Date('2026-11-01T12:00:00Z');
const a = (status: string, deadline = FUTURE) => ({ status, deadline }) as never;

describe('ASSIGNMENT bulk rules', () => {
  it("every action needs exactly the single routes' permission (assignments.publish); archive, which cannot be undone, needs a reason", () => {
    expect(Object.keys(ASSIGNMENT_ACTIONS)).toEqual([...ASSIGNMENT_BULK_ACTIONS]);
    for (const x of ASSIGNMENT_BULK_ACTIONS) expect(ASSIGNMENT_ACTIONS[x].permissions).toEqual(['assignments.publish']);
    expect(ASSIGNMENT_ACTIONS.publish.reason).toBe('optional');
    expect(ASSIGNMENT_ACTIONS.close.reason).toBe('optional');
    expect(ASSIGNMENT_ACTIONS.archive.reason).toBe('required');
  });

  it('the single routes\' transitions: publish from PENDING_APPROVAL, close from PUBLISHED, archive from every status but ARCHIVED', () => {
    expect(ASSIGNMENT_TARGET).toEqual({ publish: 'PUBLISHED', close: 'CLOSED', archive: 'ARCHIVED' });
    expect(ASSIGNMENT_FROM.publish).toEqual(['PENDING_APPROVAL']);
    expect(ASSIGNMENT_FROM.close).toEqual(['PUBLISHED']);
    expect([...ASSIGNMENT_FROM.archive].sort()).toEqual(['CLOSED', 'DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'REJECTED']);
  });

  it('guards the table the list filters read; no refusal of the single routes is a skip (wrong statuses are skipped before the call)', () => {
    expect([...ASSIGNMENT_MEMBERSHIP_TABLES]).toEqual(['Assignment']);
    expect(ASSIGNMENT_SKIP_CODES.size).toBe(0);
  });

  it('preview warnings: already done and not applicable are skipped; publishing past the deadline fails', () => {
    const rows = [a('PENDING_APPROVAL'), a('PENDING_APPROVAL', PAST), a('PUBLISHED'), a('DRAFT'), a('ARCHIVED')];
    expect(assignmentWarnings('publish', rows, NOW)).toEqual([
      { code: 'ALREADY_IN_STATE', count: 1, message: 'Assignments already published will be skipped.' },
      { code: 'NOT_APPLICABLE', count: 2, message: 'Only pending approval assignments can be published; the others will be skipped.' },
      { code: 'DEADLINE_IN_PAST', count: 1, message: 'Assignments whose deadline has passed cannot be published; they will fail.' },
    ]);
    expect(assignmentWarnings('close', rows, NOW).map((w) => [w.code, w.count])).toEqual([['NOT_APPLICABLE', 4]]);
    expect(assignmentWarnings('archive', rows, NOW).map((w) => [w.code, w.count])).toEqual([['ALREADY_IN_STATE', 1]]);
    expect(assignmentWarnings('archive', [a('DRAFT')], NOW)).toEqual([]);
  });
});
