import { describe, expect, it } from 'vitest';

import {
  BANKS, bankingIncomplete, bankingRequiredFor, bankingSummary, bankRules, checkSubmission, maskAccountNumber,
  TEACHER_NUMBER_MESSAGE, UMWALIMU_SACCO,
} from './banking-rules.js';

const teacher = {
  personalAccountName: 'Jean Uwase', personalBankName: UMWALIMU_SACCO, personalAccountNumber: '123456789012',
  schoolAccountName: 'GS Kigali', schoolBankName: UMWALIMU_SACCO, schoolAccountNumber: '4001234567',
};
const coach = { ...teacher, personalBankName: 'Bank of Kigali Plc', personalAccountNumber: '00012345678' };

describe('banking rules: who is asked', () => {
  it('Teachers, Coaches and Head Coaches only', () => {
    for (const r of ['TEACHER', 'MENTOR', 'HEAD_COACH']) expect(bankingRequiredFor(r)).toBe(true);
    for (const r of ['STUDENT', 'ADMIN', 'SUPER_ADMIN', 'UNKNOWN', undefined]) expect(bankingRequiredFor(r)).toBe(false);
    expect(bankingSummary('STUDENT', null)).toEqual({ required: false, status: null, missing: [], invalid: [] });
    expect(bankingIncomplete('ADMIN', null)).toBe(false);
  });

  it('the bank list is exactly the owner\'s twelve, Umwalimu SACCO included', () => {
    expect(BANKS).toHaveLength(12);
    expect(BANKS).toContain(UMWALIMU_SACCO);
    expect(bankRules('TEACHER')).toMatchObject({ personalBank: 'FIXED', schoolBank: 'FIXED', personalNumberDigits: 12, banks: [UMWALIMU_SACCO] });
    expect(bankRules('MENTOR')).toMatchObject({ personalBank: 'LIST', schoolBank: 'FIXED', personalNumberDigits: null });
    expect(bankRules('HEAD_COACH')).toEqual(bankRules('MENTOR'));
  });
});

describe('banking rules: completion (each field on its own)', () => {
  it('nothing given: NOT_STARTED, all six missing; some given: PARTIAL with exactly the missing ones; all: COMPLETE', () => {
    expect(bankingSummary('TEACHER', null)).toMatchObject({ status: 'NOT_STARTED', missing: expect.arrayContaining(['personalAccountName', 'schoolAccountNumber']) });
    expect(bankingSummary('TEACHER', null).missing).toHaveLength(6);
    const partial = bankingSummary('MENTOR', { personalAccountName: 'A B', schoolAccountNumber: '   ' });
    expect(partial.status).toBe('PARTIAL');
    expect(partial.missing).toEqual(['personalBankName', 'personalAccountNumber', 'schoolAccountName', 'schoolBankName', 'schoolAccountNumber']);
    expect(bankingSummary('TEACHER', teacher)).toEqual({ required: true, status: 'COMPLETE', missing: [], invalid: [] });
    expect(bankingSummary('HEAD_COACH', coach).status).toBe('COMPLETE');
    expect(bankingIncomplete('TEACHER', teacher)).toBe(false);
    expect(bankingIncomplete('MENTOR', null)).toBe(true);
  });

  it('a saved value that breaks the current role\'s rules is NEEDS_CORRECTION (never changed by the system)', () => {
    // A coach's details after the account became a teacher: another bank, an 11-digit number.
    expect(bankingSummary('TEACHER', coach)).toEqual({ required: true, status: 'NEEDS_CORRECTION', missing: [], invalid: ['personalBankName', 'personalAccountNumber'] });
    expect(bankingSummary('MENTOR', { ...coach, schoolBankName: 'Bank of Kigali Plc' }).invalid).toEqual(['schoolBankName']);
  });
});

describe('banking rules: a submission', () => {
  it('Teacher: a valid 12-digit number is accepted; both banks are set to Umwalimu SACCO when not sent', () => {
    const r = checkSubmission('TEACHER', { ...teacher, personalBankName: undefined, schoolBankName: undefined });
    expect(r).toEqual({ ok: true, values: teacher });
  });

  it.each([
    ['11 digits', '12345678901'], ['13 digits', '1234567890123'], ['letters', '12345678901A'], ['spaces', '1234 5678 9012'],
    ['symbols', '123456-789012'], ['empty', ''],
  ])('Teacher: %s refused with the exact message, nothing changed or cut', (_label, n) => {
    const r = checkSubmission('TEACHER', { ...teacher, personalAccountNumber: n });
    expect(r).toEqual({ ok: false, errors: { personalAccountNumber: TEACHER_NUMBER_MESSAGE } });
  });

  it('Teacher: another personal or school bank is refused (never silently replaced)', () => {
    const r = checkSubmission('TEACHER', { ...teacher, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' });
    expect(r.ok).toBe(false);
    expect(Object.keys((r as { errors: object }).errors).sort()).toEqual(['personalBankName', 'schoolBankName']);
  });

  it('Teacher: the 12-digit rule is for the personal number only (the school number: 6 to 20 digits)', () => {
    expect(checkSubmission('TEACHER', { ...teacher, schoolAccountNumber: '123456' }).ok).toBe(true);
  });

  it('Coach and Head Coach: a bank from the list is accepted; an arbitrary bank, or a school bank other than Umwalimu SACCO, refused', () => {
    for (const role of ['MENTOR', 'HEAD_COACH']) {
      for (const bank of BANKS) expect(checkSubmission(role, { ...coach, personalBankName: bank }).ok).toBe(true);
      expect(checkSubmission(role, { ...coach, personalBankName: 'My Own Bank' })).toMatchObject({ ok: false, errors: { personalBankName: 'Choose your bank from the list.' } });
      expect(checkSubmission(role, { ...coach, personalBankName: 'bank of kigali plc' }).ok).toBe(false);
      expect(checkSubmission(role, { ...coach, schoolBankName: 'Bank of Kigali Plc' })).toMatchObject({ ok: false, errors: { schoolBankName: expect.stringContaining(UMWALIMU_SACCO) } });
      // The personal bank is required (never defaulted for coaches); the 12-digit rule does not apply to them.
      expect(checkSubmission(role, { ...coach, personalBankName: undefined })).toMatchObject({ ok: false, errors: { personalBankName: 'Bank name is required.' } });
      expect(checkSubmission(role, { ...coach, personalAccountNumber: '123456' }).ok).toBe(true);
    }
  });

  it('missing fields are each reported; account names are trimmed, numbers never touched', () => {
    const r = checkSubmission('MENTOR', {});
    expect(r.ok).toBe(false);
    expect(Object.keys((r as { errors: object }).errors).sort()).toEqual(['personalAccountName', 'personalAccountNumber', 'personalBankName', 'schoolAccountName', 'schoolAccountNumber']);
    const ok = checkSubmission('MENTOR', { ...coach, personalAccountName: '  Jean Uwase  ' });
    expect(ok).toMatchObject({ ok: true, values: { personalAccountName: 'Jean Uwase', personalAccountNumber: '00012345678' } });
  });
});

describe('masking', () => {
  it('only the last 4 digits', () => {
    expect(maskAccountNumber('123456789012')).toBe('•••• 9012');
    expect(maskAccountNumber('123')).toBe('••••');
    expect(maskAccountNumber(null)).toBeNull();
    expect(maskAccountNumber('')).toBeNull();
  });
});
