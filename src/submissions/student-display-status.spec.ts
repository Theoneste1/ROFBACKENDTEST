import { deriveStudentDisplayStatus } from './student-display-status.js';

describe('deriveStudentDisplayStatus', () => {
  it('is Not Started without a submission', () => {
    expect(deriveStudentDisplayStatus({ submissionStatus: null })).toBe('Not Started');
  });

  it.each([
    ['SUBMITTED',              'Submitted'],
    ['ASSIGNED',               'Submitted'],
    ['IN_REVIEW',              'Pending Review'],
    ['MARKED',                 'Pending Review'],
    ['SUBMITTED_TO_ADMIN',     'Pending Review'],
    ['APPROVED',               'Pending Review'],
    ['REJECTED',               'Pending Review'],
    ['RESUBMISSION_REQUESTED', 'Resubmission Requested'],
    ['PUBLISHED',              'Reviewed'],
  ])('%s → %s', (status, expected) => {
    expect(deriveStudentDisplayStatus({ submissionStatus: status })).toBe(expected);
  });

  it('REJECTED (review returned to the mentor) never asks the student to redo', () => {
    expect(deriveStudentDisplayStatus({ submissionStatus: 'REJECTED' })).toBe('Pending Review');
  });

  it('treats an unknown status as Pending Review', () => {
    expect(deriveStudentDisplayStatus({ submissionStatus: 'SOMETHING_NEW' })).toBe('Pending Review');
  });
});
