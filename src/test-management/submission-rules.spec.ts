import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { AppError } from '../common/errors/app-error.js';
import { CreateTestExtensionDto, SubmitTestAnswerDto } from './dto/submission.dto.js';
import {
  CODE_ALPHABET, MAX_ANSWER_PAGES, answerPageName, answerWindow, applicableDeadline, assertAnswerFormat, assertBeforeDeadline,
  assertEligible, assertPagesComplete, assertUploadsAllowed, beforeDeadline, divisionMatches, divisionOfGrade, eligibilityProblems,
  formatPublicCode, lockedFieldsIn, trackingState, type ExtensionLike,
} from './submission-rules.js';

const codeOf = (fn: () => unknown): string | null => {
  try { fn(); return null; } catch (e) { return e instanceof AppError ? `${e.getStatus()} ${e.code}` : String(e); }
};

const T0 = new Date('2026-12-10T10:00:00.000Z');            // the test's own closesAt
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
let n = 0;
const ext = (kind: ExtensionLike['kind'], minutes: number, target: { studentId?: string; teacherId?: string } = {}, cancelled = false): ExtensionLike => ({
  id: `e${++n}`, kind, studentId: target.studentId ?? null, teacherId: target.teacherId ?? null, newDeadline: at(minutes), cancelledAt: cancelled ? at(-5) : null,
});
const STUDENT = { role: 'STUDENT' } as const;
const teacher = (teacherId: string) => ({ role: 'TEACHER', teacherId }) as const;

describe('Test Management rules (WS3, Phase 2)', () => {
  describe('applicable deadline: the latest of closesAt and the ACTIVE extensions that apply', () => {
    it('the test only: closesAt, not extended', () => {
      expect(applicableDeadline(T0, [], 's1', STUDENT)).toEqual({ deadline: T0, extensionId: null, extensionKind: null, extended: false });
    });

    it('a whole-test extension applies to every student, whoever submits', () => {
      const e = ext('TEST', 60);
      for (const who of [STUDENT, teacher('t1')]) {
        expect(applicableDeadline(T0, [e], 's1', who)).toMatchObject({ deadline: at(60), extensionId: e.id, extensionKind: 'TEST', extended: true });
      }
    });

    it('a student extension applies to that student only (submitted by them or by a teacher)', () => {
      const e = ext('STUDENT', 30, { studentId: 's1' });
      expect(applicableDeadline(T0, [e], 's1', STUDENT).deadline).toEqual(at(30));
      expect(applicableDeadline(T0, [e], 's1', teacher('t1')).deadline).toEqual(at(30));
      expect(applicableDeadline(T0, [e], 's2', STUDENT)).toMatchObject({ deadline: T0, extended: false });
    });

    it('a teacher extension applies only to THAT teacher\'s submissions — never the student\'s own, never another teacher\'s', () => {
      const e = ext('TEACHER', 90, { teacherId: 't1' });
      expect(applicableDeadline(T0, [e], 's1', teacher('t1'))).toMatchObject({ deadline: at(90), extensionKind: 'TEACHER' });
      expect(applicableDeadline(T0, [e], 's1', teacher('t2'))).toMatchObject({ deadline: T0, extended: false });
      expect(applicableDeadline(T0, [e], 's1', STUDENT)).toMatchObject({ deadline: T0, extended: false });
    });

    it('student AND teacher extensions both applying → the later of the two (either order)', () => {
      const s = ext('STUDENT', 30, { studentId: 's1' });
      const t = ext('TEACHER', 90, { teacherId: 't1' });
      expect(applicableDeadline(T0, [s, t], 's1', teacher('t1'))).toMatchObject({ deadline: at(90), extensionId: t.id });
      const s2 = ext('STUDENT', 120, { studentId: 's1' });
      expect(applicableDeadline(T0, [t, s2], 's1', teacher('t1'))).toMatchObject({ deadline: at(120), extensionId: s2.id });
      // The student alone does not get the teacher's.
      expect(applicableDeadline(T0, [s, t], 's1', STUDENT)).toMatchObject({ deadline: at(30), extensionId: s.id });
    });

    it('whole-test, student and teacher together: the latest wins', () => {
      const all = [ext('TEST', 45), ext('STUDENT', 30, { studentId: 's1' }), ext('TEACHER', 20, { teacherId: 't1' })];
      expect(applicableDeadline(T0, all, 's1', teacher('t1'))).toMatchObject({ deadline: at(45), extensionKind: 'TEST' });
    });

    it('cancelled extensions are ignored', () => {
      const all = [ext('TEST', 60, {}, true), ext('STUDENT', 30, { studentId: 's1' }, true), ext('TEACHER', 90, { teacherId: 't1' }, true)];
      expect(applicableDeadline(T0, all, 's1', teacher('t1'))).toMatchObject({ deadline: T0, extended: false, extensionId: null });
    });

    it('an extension never makes the deadline earlier than closesAt', () => {
      expect(applicableDeadline(T0, [ext('TEST', -60)], 's1', STUDENT)).toMatchObject({ deadline: T0, extended: false });
    });

    it('a tie keeps the whole-test extension first, then the student\'s, then the teacher\'s', () => {
      const t = ext('TEACHER', 60, { teacherId: 't1' }); const s = ext('STUDENT', 60, { studentId: 's1' });
      expect(applicableDeadline(T0, [t, s], 's1', teacher('t1')).extensionKind).toBe('STUDENT');
    });
  });

  describe('deadline boundary (database time; inclusive)', () => {
    it('exactly at the deadline: on time; one millisecond later: late (409 DEADLINE_PASSED)', () => {
      expect(beforeDeadline(T0, T0)).toBe(true);
      expect(beforeDeadline(new Date(T0.getTime() + 1), T0)).toBe(false);
      const d = applicableDeadline(T0, [], 's1', STUDENT);
      expect(codeOf(() => assertBeforeDeadline(T0, d))).toBeNull();
      expect(codeOf(() => assertBeforeDeadline(new Date(T0.getTime() + 1), d))).toBe('409 DEADLINE_PASSED');
    });

    it('with an extension the boundary moves to the extension', () => {
      const d = applicableDeadline(T0, [ext('STUDENT', 10, { studentId: 's1' })], 's1', STUDENT);
      expect(codeOf(() => assertBeforeDeadline(at(10), d))).toBeNull();
      expect(codeOf(() => assertBeforeDeadline(new Date(at(10).getTime() + 1), d))).toBe('409 DEADLINE_PASSED');
    });

    it('window and tracking states', () => {
      expect(answerWindow(at(-60), T0, at(-61))).toBe('UPCOMING');
      expect(answerWindow(at(-60), T0, T0)).toBe('OPEN');
      expect(answerWindow(at(-60), T0, at(1))).toBe('CLOSED');
      expect(trackingState(true, at(100), T0)).toBe('SUBMITTED');
      expect(trackingState(false, T0, T0)).toBe('NOT_SUBMITTED');
      expect(trackingState(false, at(1), T0)).toBe('LATE_BLOCKED');
    });
  });

  describe('eligibility: published, opened, an ACTIVE student account, the division', () => {
    const test = { status: 'PUBLISHED', opensAt: at(-60), division: 'JUNIOR' as const };
    const student = { role: 'STUDENT', accountStatus: 'ACTIVE', isActive: true, isApproved: true, activatedAt: at(-1000), gradeLevel: 'S2' };

    it('divisions: Junior S1–S3, Senior S4–S6, All any student (incl. one without a grade)', () => {
      expect(['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map(divisionOfGrade)).toEqual(['JUNIOR', 'JUNIOR', 'JUNIOR', 'SENIOR', 'SENIOR', 'SENIOR']);
      expect(divisionOfGrade(null)).toBeNull();
      expect(divisionMatches('JUNIOR', 'S3')).toBe(true);
      expect(divisionMatches('JUNIOR', 'S4')).toBe(false);
      expect(divisionMatches('SENIOR', 'S4')).toBe(true);
      expect(divisionMatches('ALL', null)).toBe(true);
      expect(divisionMatches('SENIOR', null, 'SENIOR')).toBe(true);    // no grade: the division code decides
      expect(divisionMatches('SENIOR', null, null)).toBe(false);
    });

    it('an eligible student', () => expect(eligibilityProblems(test, student, at(0))).toEqual([]));

    it('each problem, with its error', () => {
      expect(codeOf(() => assertEligible({ ...test, status: 'DRAFT' }, student, at(0)))).toBe('404 TEST_NOT_PUBLISHED');
      expect(codeOf(() => assertEligible({ ...test, opensAt: at(1) }, student, at(0)))).toBe('409 TEST_NOT_OPEN');
      expect(codeOf(() => assertEligible(test, { ...student, role: 'TEACHER' }, at(0)))).toBe('403 NOT_A_STUDENT');
      for (const bad of [{ accountStatus: 'SUSPENDED', isActive: false }, { accountStatus: 'ARCHIVED', isActive: false }, { isApproved: false }, { activatedAt: null }]) {
        expect(codeOf(() => assertEligible(test, { ...student, ...bad }, at(0)))).toBe('409 ACCOUNT_NOT_ACTIVE');
      }
      expect(codeOf(() => assertEligible(test, { ...student, gradeLevel: 'S5' }, at(0)))).toBe('403 DIVISION_MISMATCH');
      expect(codeOf(() => assertEligible({ ...test, division: 'ALL' }, { ...student, gradeLevel: 'S5' }, at(0)))).toBeNull();
    });

    it('opening boundary: at opensAt it is open', () => {
      expect(codeOf(() => assertEligible({ ...test, opensAt: at(0) }, student, at(0)))).toBeNull();
    });
  });

  describe('answer formats', () => {
    it('UPLOAD_ONLY: pages, no typed answer', () => {
      expect(codeOf(() => assertAnswerFormat('UPLOAD_ONLY', null, 2))).toBeNull();
      expect(codeOf(() => assertAnswerFormat('UPLOAD_ONLY', 'text', 2))).toBe('400 TYPED_ANSWER_NOT_ALLOWED');
      expect(codeOf(() => assertAnswerFormat('UPLOAD_ONLY', null, 0))).toBe('400 PAGES_REQUIRED');
      expect(codeOf(() => assertUploadsAllowed('UPLOAD_ONLY'))).toBeNull();
    });
    it('TYPED_ONLY: a typed answer, no pages (pages are refused before storing)', () => {
      expect(codeOf(() => assertAnswerFormat('TYPED_ONLY', 'x = 2', 0))).toBeNull();
      expect(codeOf(() => assertAnswerFormat('TYPED_ONLY', 'x = 2', 1))).toBe('400 UPLOAD_NOT_ALLOWED');
      expect(codeOf(() => assertAnswerFormat('TYPED_ONLY', '   ', 0))).toBe('400 TYPED_ANSWER_REQUIRED');
      expect(codeOf(() => assertUploadsAllowed('TYPED_ONLY'))).toBe('400 UPLOAD_NOT_ALLOWED');
    });
    it('BOTH: typed and/or pages, at least one', () => {
      expect(codeOf(() => assertAnswerFormat('BOTH', 'x', 0))).toBeNull();
      expect(codeOf(() => assertAnswerFormat('BOTH', null, 3))).toBeNull();
      expect(codeOf(() => assertAnswerFormat('BOTH', 'x', 3))).toBeNull();
      expect(codeOf(() => assertAnswerFormat('BOTH', '', 0))).toBe('400 ANSWER_REQUIRED');
    });
  });

  describe('pages of one upload: 1…n without a gap', () => {
    it('complete', () => {
      expect(codeOf(() => assertPagesComplete([1, 2, 3], 3))).toBeNull();
      expect(codeOf(() => assertPagesComplete([2, 1, 3], undefined))).toBeNull();
      expect(codeOf(() => assertPagesComplete([], 0))).toBeNull();
    });
    it('a missing page (a lost upload) is named; extra pages too', () => {
      let err: AppError | undefined;
      try { assertPagesComplete([1, 3], 4); } catch (e) { err = e as AppError; }
      expect([err?.code, (err as unknown as { details: unknown })?.details]).toEqual(['PAGES_INCOMPLETE', { missing: [2, 4], extra: [], expected: 4 }]);
      expect(codeOf(() => assertPagesComplete([1, 2, 3], 2))).toBe('409 PAGES_INCOMPLETE');
      expect(codeOf(() => assertPagesComplete([1, 3], undefined))).toBe('409 PAGES_INCOMPLETE');
    });
    it(`at most ${MAX_ANSWER_PAGES} pages`, () => {
      const many = Array.from({ length: MAX_ANSWER_PAGES + 1 }, (_, i) => i + 1);
      expect(codeOf(() => assertPagesComplete(many, undefined))).toBe('400 TOO_MANY_PAGES');
    });
  });

  describe('identity-free names and codes', () => {
    it('answer pages are served as page-N.ext', () => {
      expect(answerPageName(3, 'image/jpeg')).toBe('page-3.jpg');
      expect(answerPageName(1, 'application/pdf')).toBe('page-1.pdf');
      expect(answerPageName(2, 'image/png')).toBe('page-2.png');
      expect(answerPageName(4, 'image/heic')).toBe('page-4.heic');
    });
    it('the public code is 8 unambiguous characters, XXXX-XXXX', () => {
      const code = formatPublicCode([0, 1, 2, 3, 4, 5, 6, 30]);
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).toBe('ABCD-EFG9');
      for (const c of 'IO01L') expect(CODE_ALPHABET).not.toContain(c);
    });
  });

  it('locks after submissions: the listed fields only', () => {
    expect(lockedFieldsIn({ title: 'x', closesAt: 'y', maxMarks: 3 })).toEqual(['closesAt', 'maxMarks']);
    expect(lockedFieldsIn({ title: 'x' })).toEqual([]);
  });

  describe('DTO validation', () => {
    const errors = (cls: new () => object, body: object) => validateSync(plainToInstance(cls, body)).map((e) => e.property);
    it('an extension needs a kind, an ISO deadline and a reason of 3+ characters', () => {
      expect(errors(CreateTestExtensionDto, { kind: 'TEST', newDeadline: T0.toISOString(), reason: 'Power cut' })).toEqual([]);
      expect(errors(CreateTestExtensionDto, { kind: 'CLASS', newDeadline: 'tomorrow', reason: ' x ' }).sort()).toEqual(['kind', 'newDeadline', 'reason']);
    });
    it('a submission needs a UUID clientKey; pageCount whole, at most 30', () => {
      expect(errors(SubmitTestAnswerDto, { clientKey: '7d5e8a3c-1b2f-4c3d-9e8f-0a1b2c3d4e5f', pageCount: 2 })).toEqual([]);
      expect(errors(SubmitTestAnswerDto, { clientKey: 'abc', pageCount: 31 }).sort()).toEqual(['clientKey', 'pageCount']);
      expect(errors(SubmitTestAnswerDto, { clientKey: '7d5e8a3c-1b2f-4c3d-9e8f-0a1b2c3d4e5f', pageCount: 1.5 })).toEqual(['pageCount']);
    });
  });
});
