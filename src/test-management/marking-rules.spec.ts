import {
  ALLOWED_PAIRS, MARKER_FORBIDDEN_FIELDS, SUBMISSION_STATUSES, TRANSITIONS, assertBlind, distributeEvenly, markDiff, markingEligible,
  markingEligibleAt, nextStatus, normaliseMarks, queueState, transition, type MarkingAction, type SubmissionStatus,
} from './marking-rules.js';
import type { ExtensionLike } from './submission-rules.js';

const codeOf = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; }
  return null;
};

describe('Test Management Phase 3 — marking rules', () => {
  describe('the fixed status transition table', () => {
    // The approved flow (owner spec), written out independently of TRANSITIONS: every pair not listed is forbidden.
    const EXPECTED_PAIRS = [
      'SUBMITTED>ASSIGNED',
      'ASSIGNED>ASSIGNED', 'MARKING_IN_PROGRESS>ASSIGNED', 'RETURNED>ASSIGNED',
      'AWAITING_SECOND_MARKING>AWAITING_SECOND_MARKING', 'MARKING_IN_PROGRESS>AWAITING_SECOND_MARKING', 'RETURNED>AWAITING_SECOND_MARKING',
      'ASSIGNED>MARKING_IN_PROGRESS', 'RETURNED>MARKING_IN_PROGRESS',
      'MARKING_IN_PROGRESS>MARKED', 'AWAITING_SECOND_MARKING>MARKED',
      'MARKED>APPROVED', 'MARKED>RETURNED', 'MARKED>AWAITING_SECOND_MARKING', 'MARKED>MARKED',
      'APPROVED>MARKED',
      // Phase 4: publication, and G6 — an unlock withdraws a published result.
      'APPROVED>PUBLISHED', 'PUBLISHED>MARKED',
    ];

    it('every (from, to) pair of the 8 statuses: exactly the approved ones are allowed', () => {
      const allowed: string[] = [];
      for (const from of SUBMISSION_STATUSES) for (const to of SUBMISSION_STATUSES) if (ALLOWED_PAIRS.has(`${from}>${to}`)) allowed.push(`${from}>${to}`);
      expect(allowed.sort()).toEqual([...EXPECTED_PAIRS].sort());
      expect(SUBMISSION_STATUSES.length ** 2 - allowed.length).toBe(46);   // 64 pairs, 18 allowed
    });

    it('every action from every status: the table answers, anything else is 409 INVALID_STATUS_TRANSITION', () => {
      const expected: Record<MarkingAction, Partial<Record<SubmissionStatus, SubmissionStatus>>> = {
        ASSIGN: { SUBMITTED: 'ASSIGNED' },
        REASSIGN_FIRST: { ASSIGNED: 'ASSIGNED', MARKING_IN_PROGRESS: 'ASSIGNED', RETURNED: 'ASSIGNED' },
        REASSIGN_SECOND: { AWAITING_SECOND_MARKING: 'AWAITING_SECOND_MARKING', MARKING_IN_PROGRESS: 'AWAITING_SECOND_MARKING', RETURNED: 'AWAITING_SECOND_MARKING' },
        START_MARKING: { ASSIGNED: 'MARKING_IN_PROGRESS', RETURNED: 'MARKING_IN_PROGRESS' },
        SUBMIT_MARKING: { MARKING_IN_PROGRESS: 'MARKED', AWAITING_SECOND_MARKING: 'MARKED' },
        APPROVE: { MARKED: 'APPROVED' },
        RETURN: { MARKED: 'RETURNED' },
        REQUEST_SECOND_MARKING: { MARKED: 'AWAITING_SECOND_MARKING' },
        CHOOSE_MARK: { MARKED: 'MARKED' },
        UNLOCK: { APPROVED: 'MARKED', PUBLISHED: 'MARKED' },
        PUBLISH: { APPROVED: 'PUBLISHED' },
      };
      expect(Object.keys(TRANSITIONS).sort()).toEqual(Object.keys(expected).sort());
      for (const action of Object.keys(expected) as MarkingAction[]) {
        for (const from of SUBMISSION_STATUSES) {
          const to = expected[action][from] ?? null;
          expect([action, from, nextStatus(action, from)]).toEqual([action, from, to]);
          if (to) expect(transition(action, from)).toBe(to);
          else expect([action, from, codeOf(() => transition(action, from))]).toEqual([action, from, 'INVALID_STATUS_TRANSITION']);
        }
      }
    });

    it('no step can be skipped: SUBMITTED reaches APPROVED only through ASSIGNED, MARKING_IN_PROGRESS and MARKED', () => {
      expect(nextStatus('APPROVE', 'SUBMITTED')).toBeNull();
      expect(nextStatus('APPROVE', 'ASSIGNED')).toBeNull();
      expect(nextStatus('APPROVE', 'MARKING_IN_PROGRESS')).toBeNull();
      expect(nextStatus('SUBMIT_MARKING', 'ASSIGNED')).toBeNull();
      expect(nextStatus('SUBMIT_MARKING', 'SUBMITTED')).toBeNull();
      expect(nextStatus('START_MARKING', 'SUBMITTED')).toBeNull();
      // A second approval after the first (concurrent reviewers): refused.
      expect(codeOf(() => transition('APPROVE', 'APPROVED'))).toBe('INVALID_STATUS_TRANSITION');
    });

    it('PUBLISHED (Phase 4): reached only by PUBLISH from APPROVED; left only by UNLOCK back to MARKED (G6 withdrawal)', () => {
      const into: string[] = [];
      const out: string[] = [];
      for (const [action, rows] of Object.entries(TRANSITIONS)) for (const [from, to] of rows) {
        if (to === 'PUBLISHED') into.push(`${action}:${from}`);
        if (from === 'PUBLISHED') out.push(`${action}:${to}`);
      }
      expect(into).toEqual(['PUBLISH:APPROVED']);
      expect(out).toEqual(['UNLOCK:MARKED']);
      // Nothing unapproved can be published through the table (an override never changes a status: unapproved stay hidden).
      for (const s of SUBMISSION_STATUSES.filter((x) => x !== 'APPROVED')) expect([s, nextStatus('PUBLISH', s)]).toEqual([s, null]);
      expect(codeOf(() => transition('PUBLISH', 'PUBLISHED'))).toBe('INVALID_STATUS_TRANSITION');
      // A published result cannot be returned, re-approved, chosen or second-marked without first being unlocked.
      for (const a of ['APPROVE', 'RETURN', 'CHOOSE_MARK', 'REQUEST_SECOND_MARKING'] as const) expect(nextStatus(a, 'PUBLISHED')).toBeNull();
    });
  });

  describe('G5: marking begins only after the latest applicable deadline', () => {
    const closes = new Date('2026-12-01T10:00:00Z');
    const ext = (kind: ExtensionLike['kind'], at: string, extra: Partial<ExtensionLike> = {}): ExtensionLike =>
      ({ id: `${kind}-${at}`, kind, studentId: null, teacherId: null, newDeadline: new Date(at), cancelledAt: null, ...extra });
    const teachers = new Set(['t1']);

    it('no extension: the test closesAt; markable strictly after it (the deadline instant is still on time)', () => {
      const at = markingEligibleAt(closes, [], 's1', teachers);
      expect(at).toEqual(closes);
      expect(markingEligible(new Date(closes.getTime()), at)).toBe(false);
      expect(markingEligible(new Date(closes.getTime() + 1), at)).toBe(true);
    });

    it('whole-test, student and relevant teacher extensions all count; the latest wins', () => {
      const all = [
        ext('TEST', '2026-12-02T00:00:00Z'),
        ext('STUDENT', '2026-12-03T00:00:00Z', { studentId: 's1' }),
        ext('TEACHER', '2026-12-04T00:00:00Z', { teacherId: 't1' }),
      ];
      expect(markingEligibleAt(closes, all, 's1', teachers).toISOString()).toBe('2026-12-04T00:00:00.000Z');
      expect(markingEligibleAt(closes, all.slice(0, 2), 's1', teachers).toISOString()).toBe('2026-12-03T00:00:00.000Z');
      expect(markingEligibleAt(closes, all.slice(0, 1), 's1', teachers).toISOString()).toBe('2026-12-02T00:00:00.000Z');
    });

    it('another student\'s extension, an unrelated teacher\'s and a cancelled one never delay it', () => {
      const others = [
        ext('STUDENT', '2026-12-09T00:00:00Z', { studentId: 's2' }),
        ext('TEACHER', '2026-12-09T00:00:00Z', { teacherId: 't9' }),
        ext('TEST', '2026-12-09T00:00:00Z', { cancelledAt: new Date('2026-11-30T00:00:00Z') }),
      ];
      expect(markingEligibleAt(closes, others, 's1', teachers)).toEqual(closes);
    });

    it('an extension earlier than closesAt never brings it forward', () => {
      expect(markingEligibleAt(closes, [ext('TEST', '2026-11-30T00:00:00Z')], 's1', teachers)).toEqual(closes);
    });
  });

  describe('even distribution', () => {
    it('5,000 submissions over 20 coaches: 250 each (±1 in general), deterministic', () => {
      const subs = Array.from({ length: 5000 }, (_, i) => `s${i}`);
      const coaches = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, load: 0 }));
      const plan = distributeEvenly(subs, coaches);
      const sizes = [...plan.values()].map((v) => v.length);
      expect(sizes).toEqual(Array(20).fill(250));
      expect(new Set([...plan.values()].flat()).size).toBe(5000);
      expect(distributeEvenly(subs, coaches)).toEqual(plan);
    });

    it('uneven numbers: within one of each other', () => {
      const plan = distributeEvenly(Array.from({ length: 103 }, (_, i) => `s${i}`), [{ id: 'a', load: 0 }, { id: 'b', load: 0 }, { id: 'c', load: 0 }, { id: 'd', load: 0 }]);
      const sizes = [...plan.values()].map((v) => v.length);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(103);
    });

    it('existing load counts: a coach already ahead receives fewer, totals end level', () => {
      const plan = distributeEvenly(Array.from({ length: 10 }, (_, i) => `s${i}`), [{ id: 'a', load: 6 }, { id: 'b', load: 0 }]);
      expect([plan.get('a')!.length, plan.get('b')!.length]).toEqual([2, 8]);
    });

    it('no coach: nothing is planned', () => {
      expect([...distributeEvenly(['s1'], []).values()]).toEqual([]);
    });
  });

  describe('marks: whole numbers, never above the maxima (G7)', () => {
    const qs = [{ id: 'q1', order: 1, maxMarks: 5 }, { id: 'q2', order: 2, maxMarks: 15 }];

    it('per question: the total is the sum; a draft may be partial, a submission may not', () => {
      expect(normaliseMarks(qs, 20, { scores: [{ questionId: 'q2', marks: 12, comment: ' good ' }] }, false)).toEqual({
        scores: [{ questionId: 'q2', marks: 12, comment: 'good' }], totalMarks: 12, comment: null, complete: false,
      });
      expect(codeOf(() => normaliseMarks(qs, 20, { scores: [{ questionId: 'q2', marks: 12 }] }, true))).toBe('MARKS_INCOMPLETE');
      expect(normaliseMarks(qs, 20, { scores: [{ questionId: 'q1', marks: 5 }, { questionId: 'q2', marks: 0 }], comment: 'ok' }, true))
        .toMatchObject({ totalMarks: 5, complete: true, comment: 'ok' });
      expect(normaliseMarks(qs, 20, { scores: [{ questionId: 'q1', marks: null, comment: 'look again' }] }, false))
        .toMatchObject({ scores: [{ questionId: 'q1', marks: null, comment: 'look again' }], totalMarks: null });
    });

    it('refuses fractions, negatives, marks above a question\'s maximum, unknown and repeated questions, a separate total', () => {
      expect(codeOf(() => normaliseMarks(qs, 20, { scores: [{ questionId: 'q1', marks: 2.5 }] }, false))).toBe('MARKS_NOT_WHOLE');
      expect(codeOf(() => normaliseMarks(qs, 20, { scores: [{ questionId: 'q1', marks: -1 }] }, false))).toBe('MARKS_NOT_WHOLE');
      expect(codeOf(() => normaliseMarks(qs, 20, { scores: [{ questionId: 'q1', marks: 6 }] }, false))).toBe('MARKS_EXCEED_MAXIMUM');
      expect(codeOf(() => normaliseMarks(qs, 20, { scores: [{ questionId: 'qX', marks: 1 }] }, false))).toBe('QUESTION_NOT_IN_TEST');
      expect(codeOf(() => normaliseMarks(qs, 20, { scores: [{ questionId: 'q1', marks: 1 }, { questionId: 'q1', marks: 2 }] }, false))).toBe('DUPLICATE_QUESTION');
      expect(codeOf(() => normaliseMarks(qs, 20, { totalMarks: 10 }, false))).toBe('TOTAL_NOT_ALLOWED');
    });

    it('one total without questions: 0 to the test maximum, whole; no per-question scores', () => {
      expect(normaliseMarks([], 20, { totalMarks: 20 }, true)).toMatchObject({ totalMarks: 20, complete: true });
      expect(normaliseMarks([], 20, { totalMarks: 0 }, true)).toMatchObject({ totalMarks: 0, complete: true });
      expect(codeOf(() => normaliseMarks([], 20, { totalMarks: 21 }, false))).toBe('MARKS_EXCEED_MAXIMUM');
      expect(codeOf(() => normaliseMarks([], 20, { totalMarks: 19.5 }, false))).toBe('MARKS_NOT_WHOLE');
      expect(codeOf(() => normaliseMarks([], 20, {}, true))).toBe('MARKS_INCOMPLETE');
      expect(codeOf(() => normaliseMarks([], 20, { scores: [{ questionId: 'q1', marks: 1 }] }, false))).toBe('SCORES_NOT_ALLOWED');
    });

    it('markDiff lists exactly the marks that changed (old → new, null = not given)', () => {
      const before = new Map<string | null, number | null>([['q1', 3], ['q2', 10]]);
      const after = new Map<string | null, number | null>([['q1', 3], ['q2', 12], ['q3', 1]]);
      expect(markDiff(before, after)).toEqual([
        { questionId: 'q2', oldMarks: 10, newMarks: 12 },
        { questionId: 'q3', oldMarks: null, newMarks: 1 },
      ]);
      expect(markDiff(new Map([[null, 7]]), new Map([[null, 7]]))).toEqual([]);
      expect(markDiff(new Map([['q1', 4]]), new Map())).toEqual([{ questionId: 'q1', oldMarks: 4, newMarks: null }]);
    });
  });

  describe('the marker queue and blind marking', () => {
    it('queue state from the marker\'s own marking', () => {
      expect([null, 'DRAFT', 'RETURNED', 'SUBMITTED', 'APPROVED'].map((s) => queueState(s as never)))
        .toEqual(['NOT_STARTED', 'IN_PROGRESS', 'IN_PROGRESS', 'MARKED', 'MARKED']);
    });

    it('the forbidden field list covers identity, school, contacts, submitter, teacher, extensions, times and other markers', () => {
      for (const f of ['student', 'firstName', 'lastName', 'username', 'email', 'phone', 'school', 'schoolId', 'gradeLevel', 'submittedBy',
        'submitterRole', 'teacher', 'teacherId', 'submittedAt', 'underExtension', 'extended', 'extensionId', 'deadline', 'marker', 'markings']) {
        expect(MARKER_FORBIDDEN_FIELDS).toContain(f);
      }
    });

    it('assertBlind passes a marker view and refuses a leak at any depth', () => {
      const view = {
        code: 'ABCD-EFGH', test: { title: 'Round', subject: { name: 'Mathematics' }, questions: [{ id: 'q', order: 1, prompt: 'P', maxMarks: 5 }] },
        answer: { typedAnswer: 'x', pages: [{ page: 1, name: 'page-1.jpg', mimeType: 'image/jpeg', size: 3 }] },
        myMarking: { status: 'DRAFT', scores: [{ questionId: 'q', marks: 2, comment: null }] },
      };
      expect(() => assertBlind(view)).not.toThrow();
      expect(() => assertBlind({ ...view, answer: { ...view.answer, pages: [{ page: 1, student: { id: 's' } }] } })).toThrow(/answer\.pages\[0\]\.student/);
      expect(() => assertBlind({ data: [{ code: 'X', underExtension: true }] })).toThrow(/underExtension/);
      expect(() => assertBlind({ myMarking: { submittedBy: 'x' } })).toThrow(/submittedBy/);
    });
  });
});
