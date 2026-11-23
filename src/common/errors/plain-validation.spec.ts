import { describe, expect, it } from 'vitest';

import { fieldLabel, plainValidationMessage, validationSummary } from './plain-validation.js';

describe('validation messages in plain words (owner 2026-11-22)', () => {
  it('field names become labels', () => {
    expect(fieldLabel('opensAt')).toBe('Opens at');
    expect(fieldLabel('schoolId')).toBe('School');
    expect(fieldLabel('proposedSchoolCode')).toBe('Proposed school code');
    expect(fieldLabel('questions.0.prompt')).toBe('Question 1: prompt');
    expect(fieldLabel('email')).toBe('Email');
  });

  it('the validation pipe\'s default sentences are rewritten', () => {
    expect(plainValidationMessage('opensAt must be a valid ISO 8601 date string')).toBe('Opens at must be a valid date and time.');
    expect(plainValidationMessage('title should not be empty')).toBe('Title is required.');
    expect(plainValidationMessage('title must be longer than or equal to 3 characters')).toBe('Title must be at least 3 characters long.');
    expect(plainValidationMessage('maxMarks must not be less than 1')).toBe('Max marks must be 1 or more.');
    expect(plainValidationMessage('division must be one of the following values: JUNIOR, SENIOR')).toBe('Division: choose one of the options offered.');
    expect(plainValidationMessage('subjectId must be a UUID')).toMatch(/^Subject: choose an item from the list/);
    expect(plainValidationMessage('property foo should not exist')).toMatch(/^Foo isn't accepted here\. Refresh the page/);
    expect(plainValidationMessage('maxMarks must be an integer number')).toBe('Max marks must be a whole number.');
  });

  it('messages already written for people are kept', () => {
    expect(plainValidationMessage('Choose a school from the list.')).toBe('Choose a school from the list.');
    expect(plainValidationMessage('Enter the 6-digit code.')).toBe('Enter the 6-digit code.');
  });

  it('the summary names the first problem and counts the others', () => {
    expect(validationSummary(['title should not be empty'])).toBe('Title is required.');
    expect(validationSummary(['title should not be empty', 'a should not be empty', 'b should not be empty']))
      .toBe('Title is required. (and 2 more problems — check the form)');
    expect(validationSummary([])).toMatch(/missing or not valid/);
  });
});
