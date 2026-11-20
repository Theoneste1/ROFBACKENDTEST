import {
  RESULT_FORBIDDEN_FIELDS, STUDENT_RANKINGS_ENABLED, UNAPPROVED_STATUSES, assertResultSafe, average, competitionRank, decidePublication,
  distributionBands, median, rankingDivision, resultView, studentRankingsVisible, type PublicationRequest,
} from './results-rules.js';
import { SUBMISSION_STATUSES } from './marking-rules.js';

const codeOf = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return [(e as { getStatus?: () => number }).getStatus?.(), (e as { code?: string }).code]; } };
const req = (r: Partial<PublicationRequest>): PublicationRequest =>
  ({ mayOverride: false, override: false, reason: null, approved: 0, unapproved: 0, publications: 0, ...r });

describe('Test Management Phase 4 — results rules', () => {
  describe('publication: Head Coach blocked, Administrator override with a reason, idempotent', () => {
    it('everything approved: an ordinary publication (Head Coach or Administrator), no override recorded', () => {
      expect(decidePublication(req({ approved: 5 }))).toEqual({ kind: 'PUBLISH', override: false, reason: null });
      expect(decidePublication(req({ approved: 5, mayOverride: true }))).toEqual({ kind: 'PUBLISH', override: false, reason: null });
      // An Administrator's override when nothing is unapproved overrides nothing: an ordinary publication.
      expect(decidePublication(req({ approved: 5, mayOverride: true, override: true, reason: 'Board meeting tomorrow' })))
        .toEqual({ kind: 'PUBLISH', override: false, reason: null });
    });

    it('a Head Coach is BLOCKED while any result is unapproved (409 PUBLICATION_BLOCKED, no override offered)', () => {
      expect(codeOf(() => decidePublication(req({ approved: 5, unapproved: 1 })))).toEqual([409, 'PUBLICATION_BLOCKED']);
      try { decidePublication(req({ approved: 5, unapproved: 2 })); } catch (e) {
        expect((e as { details?: unknown }).details).toEqual({ unapproved: 2, approved: 5, overrideAvailable: false });
      }
    });

    it('a Head Coach can NEVER override — whatever the request says, with or without a reason (403 OVERRIDE_NOT_ALLOWED)', () => {
      expect(codeOf(() => decidePublication(req({ approved: 5, unapproved: 1, override: true, reason: 'Please let me publish' }))))
        .toEqual([403, 'OVERRIDE_NOT_ALLOWED']);
      expect(codeOf(() => decidePublication(req({ approved: 5, unapproved: 0, override: true, reason: 'Please let me publish' }))))
        .toEqual([403, 'OVERRIDE_NOT_ALLOWED']);
    });

    it('an Administrator is blocked too without an override; the override needs a reason of at least 10 characters', () => {
      expect(codeOf(() => decidePublication(req({ approved: 5, unapproved: 1, mayOverride: true })))).toEqual([409, 'PUBLICATION_BLOCKED']);
      for (const reason of [null, undefined, '', '   ', 'too short']) {
        expect([reason, codeOf(() => decidePublication(req({ approved: 5, unapproved: 1, mayOverride: true, override: true, reason })))])
          .toEqual([reason, [400, 'OVERRIDE_REASON_REQUIRED']]);
      }
      expect(decidePublication(req({ approved: 5, unapproved: 1, mayOverride: true, override: true, reason: '  Ceremony on Friday  ' })))
        .toEqual({ kind: 'PUBLISH', override: true, reason: 'Ceremony on Friday' });
    });

    it('nothing approved: never a publication — a replay of the latest when everything is out, else 409 NOTHING_TO_PUBLISH', () => {
      expect(decidePublication(req({ approved: 0, unapproved: 0, publications: 1 }))).toEqual({ kind: 'REPLAY' });
      expect(codeOf(() => decidePublication(req({ approved: 0, unapproved: 0, publications: 0 })))).toEqual([409, 'NOTHING_TO_PUBLISH']);
      expect(codeOf(() => decidePublication(req({ approved: 0, unapproved: 3, publications: 1, mayOverride: true, override: true, reason: 'Ceremony on Friday' }))))
        .toEqual([409, 'NOTHING_TO_PUBLISH']);
    });

    it('the unapproved statuses are exactly those before APPROVED (PUBLISHED is approved and out)', () => {
      expect([...UNAPPROVED_STATUSES].sort()).toEqual(SUBMISSION_STATUSES.filter((s) => s !== 'APPROVED' && s !== 'PUBLISHED').sort());
    });
  });

  describe('rankings: competition rank, deterministic ties, per group', () => {
    const rows = [
      { id: 'a', total: 15, lastName: 'Uwase', firstName: 'Aline', group: 'S1' },
      { id: 'b', total: 18, lastName: 'Mugisha', firstName: 'Eric', group: 'S1' },
      { id: 'c', total: 15, lastName: 'Habimana', firstName: 'Jean', group: 'S2' },
      { id: 'd', total: 15, lastName: 'Habimana', firstName: 'Alice', group: 'S1' },
      { id: 'e', total: 10, lastName: 'Ishimwe', firstName: 'Bella', group: 'S2' },
    ];

    it('overall: equal totals share the rank, the next rank skips the tied places ("1224"); ties listed by last name, first name, id', () => {
      const r = competitionRank(rows.map(({ group, ...x }) => x));
      expect(r.map((x) => [x.id, x.rank])).toEqual([['b', 1], ['d', 2], ['c', 2], ['a', 2], ['e', 5]]);
    });

    it('the same input in any order gives the same ranking', () => {
      const plain = rows.map(({ group, ...x }) => x);
      expect(competitionRank([...plain].reverse())).toEqual(competitionRank(plain));
    });

    it('by group (division or school): ranks restart in each group', () => {
      const r = competitionRank(rows);
      expect(r.map((x) => [x.group, x.id, x.rank])).toEqual([
        ['S1', 'b', 1], ['S1', 'd', 2], ['S1', 'a', 2], ['S2', 'c', 1], ['S2', 'e', 2],
      ]);
    });

    it('identical names and totals: the id decides the order, never the input order', () => {
      const twins = [{ id: 'z', total: 9, lastName: 'Same', firstName: 'Name' }, { id: 'y', total: 9, lastName: 'Same', firstName: 'Name' }];
      expect(competitionRank(twins).map((x) => [x.id, x.rank])).toEqual([['y', 1], ['z', 1]]);
    });

    it('divisions for rankings: S1–S3 Junior, S4–S6 Senior, anything else unknown', () => {
      expect(['S1', 'S3', 'S4', 'S6', null, undefined, 'P6'].map((g) => rankingDivision(g as string | null))).toEqual(
        ['JUNIOR', 'JUNIOR', 'SENIOR', 'SENIOR', 'UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    });
  });

  describe('reports', () => {
    it('distribution in ten whole-percentage bands; the maximum falls in the last one', () => {
      const b = distributionBands([0, 1, 9, 10, 19, 20, 20], 20);
      expect(b.map((x) => x.count)).toEqual([2, 0, 0, 0, 1, 1, 0, 0, 0, 3]);   // 0 %, 5 %, 45 %, 50 %, 95 %, 100 %, 100 %
      expect(b[0]).toEqual({ from: 0, to: 9, count: 2 });
      expect(b[9]).toEqual({ from: 90, to: 100, count: 3 });
      expect(distributionBands([], 20).reduce((a, x) => a + x.count, 0)).toBe(0);
    });

    it('average (two decimals) and median; none without values', () => {
      expect(average([1, 2, 2])).toBe(1.67);
      expect(median([5, 1, 3])).toBe(3);
      expect(median([4, 1, 3, 2])).toBe(2.5);
      expect([average([]), median([])]).toEqual([null, null]);
    });
  });

  describe('what students and teachers receive', () => {
    const questions = [{ id: 'q2', order: 2, prompt: 'Two', maxMarks: 15 }, { id: 'q1', order: 1, prompt: 'One', maxMarks: 5 }];

    it('the final marking only: per question (in order) marks and comment, the total, the overall comment — nothing else', () => {
      const v = resultView(questions, 20, { totalMarks: 17, comment: 'Well done', scores: [{ questionId: 'q1', marks: 4, comment: 'Sign error' }, { questionId: 'q2', marks: 13, comment: null }] });
      expect(v).toEqual({
        totalMarks: 17, maxMarks: 20, comment: 'Well done',
        questions: [
          { order: 1, prompt: 'One', maxMarks: 5, marks: 4, comment: 'Sign error' },
          { order: 2, prompt: 'Two', maxMarks: 15, marks: 13, comment: null },
        ],
      });
      expect(() => assertResultSafe(v)).not.toThrow();
    });

    it('assertResultSafe refuses a rank, a marker, another marking or a code at any depth', () => {
      for (const k of ['rank', 'position', 'marker', 'markerId', 'markings', 'secondMarking', 'publicCode', 'reviews', 'kind']) {
        expect([k, codeOf(() => assertResultSafe({ data: [{ result: { [k]: 1 } }] })) === null]).toEqual([k, false]);
      }
      expect(RESULT_FORBIDDEN_FIELDS).toEqual(expect.arrayContaining(['rank', 'ranking', 'rankings', 'marker', 'markerId', 'markings']));
    });

    it('rankings for students: designed (a per-test option exists) but OFF — never visible, whatever the test row says', () => {
      expect(STUDENT_RANKINGS_ENABLED).toBe(false);
      expect(studentRankingsVisible({ studentRankingsVisible: true })).toBe(false);
      expect(studentRankingsVisible({ studentRankingsVisible: false })).toBe(false);
    });
  });
});
