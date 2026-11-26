import { describe, expect, it } from 'vitest';

import { FIRST_STATUSES, SECOND_STATUSES, TASK_TRANSITIONS, paperProgress, projectPaper, taskRef, transitionAllowed, validMarks, type TaskStatus } from './question-rules.js';

/** An independent statement of design §4's rules, written as a lookup over counts (not the implementation's order). */
function reference(statuses: readonly TaskStatus[]): string {
  const n = statuses.length;
  const count = (s: TaskStatus) => statuses.filter((x) => x === s).length;
  if (n === 0) return 'SUBMITTED';
  if (count('RETURNED') > 0) return 'RETURNED';
  if (count('APPROVED') === n) return 'APPROVED';
  if (count('SUBMITTED') + count('UNDER_REVIEW') + count('AWAITING_SECOND') + count('APPROVED') === n) return 'MARKED';
  if (count('NOT_STARTED') < n) return 'MARKING_IN_PROGRESS';
  return 'SUBMITTED';
}

function* combinations(k: number): Generator<TaskStatus[]> {
  if (k === 0) { yield []; return; }
  for (const head of FIRST_STATUSES) for (const rest of combinations(k - 1)) yield [head, ...rest];
}

describe('projectPaper (design §4) — exhaustive over 1, 2 and 3 questions (7 + 49 + 343 combinations)', () => {
  it('matches the independent reference for every combination', () => {
    let checked = 0;
    for (const k of [1, 2, 3]) {
      for (const c of combinations(k)) {
        expect([c.join(','), projectPaper(c)]).toEqual([c.join(','), reference(c)]);
        checked++;
      }
    }
    expect(checked).toBe(7 + 49 + 343);
  });

  it("the owner's examples", () => {
    expect(projectPaper(['APPROVED', 'SUBMITTED', 'IN_PROGRESS'])).toBe('MARKING_IN_PROGRESS');
    expect(projectPaper(['APPROVED', 'RETURNED', 'APPROVED'])).toBe('RETURNED');
    expect(projectPaper(['APPROVED', 'APPROVED', 'APPROVED'])).toBe('APPROVED');
    expect(projectPaper([])).toBe('SUBMITTED');
  });

  it('never APPROVED unless every question is approved', () => {
    for (const k of [1, 2, 3]) for (const c of combinations(k)) {
      if (projectPaper(c) === 'APPROVED') expect(c.every((s) => s === 'APPROVED')).toBe(true);
    }
  });

  it('progress labels', () => {
    expect(paperProgress(['NOT_STARTED', 'NOT_STARTED'])).toBe('NOT_STARTED');
    expect(paperProgress(['IN_PROGRESS', 'NOT_STARTED'])).toBe('PARTIALLY_MARKED');
    expect(paperProgress(['SUBMITTED', 'AWAITING_SECOND'])).toBe('ALL_SUBMITTED');
    expect(paperProgress(['APPROVED', 'SUBMITTED'])).toBe('PARTIALLY_APPROVED');
    expect(paperProgress(['APPROVED', 'RETURNED'])).toBe('RETURNED_WORK');
    expect(paperProgress(['APPROVED'])).toBe('FULLY_APPROVED');
  });
});

describe('task transitions (design §4)', () => {
  it('FIRST and SECOND use only their own statuses', () => {
    for (const t of TASK_TRANSITIONS) {
      const [round, pair] = t.split(':');
      const [from, to] = pair.split('>') as [TaskStatus, TaskStatus];
      const allowed = round === 'FIRST' ? FIRST_STATUSES : SECOND_STATUSES;
      expect([t, allowed.includes(from) && allowed.includes(to)]).toEqual([t, true]);
    }
  });
  it('the key moves', () => {
    expect(transitionAllowed('FIRST', 'NOT_STARTED', 'IN_PROGRESS')).toBe(true);
    expect(transitionAllowed('FIRST', 'NOT_STARTED', 'APPROVED')).toBe(false);
    expect(transitionAllowed('FIRST', 'IN_PROGRESS', 'APPROVED')).toBe(false);
    expect(transitionAllowed('FIRST', 'APPROVED', 'RETURNED')).toBe(true);
    expect(transitionAllowed('FIRST', 'AWAITING_SECOND', 'SUBMITTED')).toBe(true);
    expect(transitionAllowed('SECOND', 'SUBMITTED', 'APPROVED')).toBe(false);
    expect(transitionAllowed('SECOND', 'SUBMITTED', 'CLOSED')).toBe(true);
    expect(transitionAllowed('SECOND', 'CLOSED', 'IN_PROGRESS')).toBe(false);
    expect(transitionAllowed('FIRST', 'RETURNED', 'RETURNED')).toBe(true);
  });
});

describe('helpers', () => {
  it('task references never carry a student', () => {
    expect(taskRef('7MX2-97NP', 2, 'FIRST', 0)).toBe('7MX2-97NP/q2');
    expect(taskRef('7MX2-97NP', 2, 'SECOND', 1)).toBe('7MX2-97NP/q2/second-1');
  });
  it('whole marks within the maximum', () => {
    expect(validMarks(0, 8)).toBe(true);
    expect(validMarks(8, 8)).toBe(true);
    expect(validMarks(null, 8)).toBe(true);
    for (const bad of [-1, 9, 2.5, '3', undefined, NaN]) expect(validMarks(bad, 8)).toBe(false);
  });
});
