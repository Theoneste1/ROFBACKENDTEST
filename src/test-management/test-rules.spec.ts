import { readFileSync } from 'fs';
import { join } from 'path';

import { AppError } from '../common/errors/app-error.js';
import {
  assertMaxMarksCoversQuestions, assertPublishable, assertQuestionMarks, assertSubjectInScope, assertWindow, inSubjectScope,
  neutralFileName, nextOriginalClosesAt, publishProblems, questionTotals, subjectFilter,
} from './test-rules.js';
import { CreateTestDto } from './dto/test.dto.js';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

const codeOf = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof AppError ? `${e.getStatus()} ${e.code}` : String(e); }
};

describe('Test Management rules (WS3, Phase 1)', () => {
  describe('window: opensAt strictly before closesAt', () => {
    const t = new Date('2026-12-01T08:00:00Z');
    it('accepts an open window', () => expect(codeOf(() => assertWindow(t, new Date(t.getTime() + 1)))).toBeNull());
    it.each([['equal', 0], ['reversed', -60_000]])('refuses %s times with 400 INVALID_TEST_WINDOW', (_, delta) => {
      expect(codeOf(() => assertWindow(t, new Date(t.getTime() + delta)))).toBe('400 INVALID_TEST_WINDOW');
    });
  });

  describe('question sum rule', () => {
    it('totals: none is complete (one total mark); exact is complete; below is incomplete', () => {
      expect(questionTotals(20, [])).toEqual({ count: 0, total: 0, complete: true, remaining: 20 });
      expect(questionTotals(20, [5, 15])).toEqual({ count: 2, total: 20, complete: true, remaining: 0 });
      expect(questionTotals(20, [5, 10])).toEqual({ count: 2, total: 15, complete: false, remaining: 5 });
    });

    it('a draft may be incomplete but never above the total (400 QUESTION_MARKS_EXCEED_TOTAL)', () => {
      expect(codeOf(() => assertQuestionMarks('DRAFT', 20, [5, 10]))).toBeNull();
      expect(codeOf(() => assertQuestionMarks('DRAFT', 20, [10, 10]))).toBeNull();
      expect(codeOf(() => assertQuestionMarks('DRAFT', 20, [10, 11]))).toBe('400 QUESTION_MARKS_EXCEED_TOTAL');
    });

    it('a published test with questions totals exactly its maximum (409 QUESTION_MARKS_MISMATCH); none is fine', () => {
      expect(codeOf(() => assertQuestionMarks('PUBLISHED', 20, [10, 10]))).toBeNull();
      expect(codeOf(() => assertQuestionMarks('PUBLISHED', 20, []))).toBeNull();
      expect(codeOf(() => assertQuestionMarks('PUBLISHED', 20, [10, 9]))).toBe('409 QUESTION_MARKS_MISMATCH');
      expect(codeOf(() => assertQuestionMarks('PUBLISHED', 20, [10, 11]))).toBe('400 QUESTION_MARKS_EXCEED_TOTAL');
    });

    it('a test maximum cannot drop below its questions (400 TEST_MAX_MARKS_BELOW_QUESTIONS)', () => {
      expect(codeOf(() => assertMaxMarksCoversQuestions(15, [5, 10]))).toBeNull();
      expect(codeOf(() => assertMaxMarksCoversQuestions(14, [5, 10]))).toBe('400 TEST_MAX_MARKS_BELOW_QUESTIONS');
    });
  });

  describe('publishing', () => {
    const now = new Date('2026-12-01T00:00:00Z');
    const later = new Date('2026-12-10T00:00:00Z');
    it('needs a paper or questions, an exact question total and a deadline still ahead', () => {
      expect(publishProblems({ maxMarks: 10, closesAt: later, hasPaper: true, questionMarks: [] }, now)).toEqual([]);
      expect(publishProblems({ maxMarks: 10, closesAt: later, hasPaper: false, questionMarks: [4, 6] }, now)).toEqual([]);
      expect(publishProblems({ maxMarks: 10, closesAt: now, hasPaper: false, questionMarks: [4] }, now))
        .toEqual(['QUESTION_MARKS_MISMATCH', 'ALREADY_CLOSED']);
      expect(publishProblems({ maxMarks: 10, closesAt: later, hasPaper: false, questionMarks: [] }, now)).toEqual(['NO_PAPER_OR_QUESTIONS']);
      expect(codeOf(() => assertPublishable({ maxMarks: 10, closesAt: later, hasPaper: false, questionMarks: [] }, now))).toBe('409 TEST_NOT_READY');
    });

    it('originalClosesAt follows the deadline until the first publication, then stays', () => {
      const first = new Date('2026-12-05T00:00:00Z');
      const moved = new Date('2026-12-07T00:00:00Z');
      expect(nextOriginalClosesAt({ publishedAt: null, originalClosesAt: first }, moved)).toBe(moved);
      expect(nextOriginalClosesAt({ publishedAt: now, originalClosesAt: first }, moved)).toBe(first);
    });
  });

  describe('subject scope (Administrators: all; Head Coaches: the subjects they head)', () => {
    it('all, headed, not headed', () => {
      expect(inSubjectScope('all', 'math')).toBe(true);
      expect(inSubjectScope(['math'], 'math')).toBe(true);
      expect(inSubjectScope(['math'], 'phys')).toBe(false);
      expect(inSubjectScope([], 'math')).toBe(false);
      expect(codeOf(() => assertSubjectInScope(['math'], 'phys'))).toBe('403 SCOPE_FORBIDDEN');
      expect(codeOf(() => assertSubjectInScope('all', 'phys'))).toBeNull();
    });

    it('list filter: none for Administrators, the headed subjects otherwise (none headed → nothing)', () => {
      expect(subjectFilter('all')).toEqual({});
      expect(subjectFilter(['math'])).toEqual({ disciplineId: { in: ['math'] } });
      expect(subjectFilter([])).toEqual({ disciplineId: { in: [] } });
    });
  });

  it('files are served under neutral names, never the uploader\'s', () => {
    expect(neutralFileName('PAPER', 'tests/papers/2026/11/abc.pdf')).toBe('test-paper.pdf');
    expect(neutralFileName('MARKING_GUIDE', 'tests/guides/2026/11/abc.JPG')).toBe('marking-guide.jpg');
  });

  describe('create validation (division mandatory, whole positive marks, answer format enum)', () => {
    const valid = {
      title: 'Round 1', subjectId: '7d5e8a3c-1b2f-4c3d-9e8f-0a1b2c3d4e5f', division: 'JUNIOR', answerFormat: 'BOTH',
      opensAt: '2026-12-01T08:00:00Z', closesAt: '2026-12-01T10:00:00Z', maxMarks: 20,
    };
    const errors = (o: object) => validateSync(plainToInstance(CreateTestDto, o)).map((e) => e.property).sort();
    it('a complete body is valid', () => expect(errors(valid)).toEqual([]));
    it('any division code and ALL pass validation (administrator-managed divisions; the service checks it is active)', () => {
      for (const division of ['JUNIOR', 'MIDDLE', 'SENIOR', 'ADVANCED_2', 'ALL']) expect([division, errors({ ...valid, division })]).toEqual([division, []]);
    });
    it.each([
      ['division missing', { division: undefined }, ['division']],
      ['not a division code', { division: 'junior level' }, ['division']],
      ['unknown answer format', { answerFormat: 'ORAL' }, ['answerFormat']],
      ['fractional marks', { maxMarks: 12.5 }, ['maxMarks']],
      ['zero marks', { maxMarks: 0 }, ['maxMarks']],
      ['negative marks', { maxMarks: -3 }, ['maxMarks']],
      ['a question with fractional marks', { questions: [{ prompt: 'Q1', maxMarks: 2.5 }] }, ['questions']],
    ])('%s is refused', (_, patch, props) => expect(errors({ ...valid, ...patch })).toEqual(props));
  });

  it('the service never changes the course-assignment pipeline (new Test* tables only)', () => {
    for (const f of ['tests.service.ts', 'test-markers.service.ts']) {
      const text = readFileSync(join(__dirname, f), 'utf8');
      expect([f, /\b(assignment|submission|mentorReview|resultRelease|course)\./.test(text)]).toEqual([f, false]);
    }
  });
});
