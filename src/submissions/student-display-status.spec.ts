import { deriveStudentDisplayStatus } from './student-display-status.js';

describe('deriveStudentDisplayStatus', () => {
  describe('without a submission', () => {
    it('is New when the student has not opened the assignment', () => {
      expect(deriveStudentDisplayStatus({ hasViewed: false, submissionStatus: null })).toBe('New');
    });

    it('is Opened once the student has viewed it', () => {
      expect(deriveStudentDisplayStatus({ hasViewed: true, submissionStatus: null })).toBe('Opened');
    });
  });

  it.each([
    ['SUBMITTED',          'Submitted'],
    ['ASSIGNED',           'Submitted'],
    ['IN_REVIEW',          'In Review'],
    ['MARKED',             'In Review'],
    ['SUBMITTED_TO_ADMIN', 'In Review'],
    ['APPROVED',           'In Review'],
    ['REJECTED',           'In Review'],
    ['PUBLISHED',          'Marked'],
  ])('%s → %s', (status, expected) => {
    expect(deriveStudentDisplayStatus({ hasViewed: true, submissionStatus: status })).toBe(expected);
    // The view flag is irrelevant once work has been submitted.
    expect(deriveStudentDisplayStatus({ hasViewed: false, submissionStatus: status })).toBe(expected);
  });

  it('REJECTED (review returned to the mentor) never asks the student to redo', () => {
    expect(deriveStudentDisplayStatus({ hasViewed: true, submissionStatus: 'REJECTED' })).toBe('In Review');
  });

  it('treats an unknown status as In Review', () => {
    expect(deriveStudentDisplayStatus({ hasViewed: true, submissionStatus: 'SOMETHING_NEW' })).toBe('In Review');
  });
});
