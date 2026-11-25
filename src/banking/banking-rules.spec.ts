import { describe, expect, it } from 'vitest';

import {
  BANKS, bankConflicts, bankingIncomplete, bankingRequiredFor, bankingSummary, bankRules, checkSubmission, confirmReplaceMessage,
  maskAccountNumber, TEACHER_NUMBER_MESSAGE, UMWALIMU_SACCO,
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
    expect(BANKS).toContain('Zigama Credit and Savings Bank');
    expect(BANKS.some((b) => b.includes('Zigama CSS'))).toBe(false);
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
    expect(r).toMatchObject({ ok: false, errors: { personalAccountNumber: TEACHER_NUMBER_MESSAGE } });
    expect(Object.keys((r as { errors: object }).errors)).toEqual(['personalAccountNumber']);
  });

  it('Teacher: another personal or school bank is refused (never silently replaced)', () => {
    const r = checkSubmission('TEACHER', { ...teacher, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' });
    expect(r.ok).toBe(false);
    expect(Object.keys((r as { errors: object }).errors).sort()).toEqual(['personalBankName', 'schoolBankName']);
  });

  it('Teacher: the 12-digit rule is for the personal number only; no format is imposed on the school number', () => {
    for (const n of ['1', '123456', '4001-2345-6789', 'SCH 001 22', '1234567890123456789012345']) {
      expect(checkSubmission('TEACHER', { ...teacher, schoolAccountNumber: n })).toEqual({ ok: true, values: { ...teacher, schoolAccountNumber: n } });
    }
  });

  it('Coach and Head Coach: a bank from the list is accepted; an arbitrary bank, or a school bank other than Umwalimu SACCO, refused', () => {
    for (const role of ['MENTOR', 'HEAD_COACH']) {
      for (const bank of BANKS) expect(checkSubmission(role, { ...coach, personalBankName: bank }).ok).toBe(true);
      expect(checkSubmission(role, { ...coach, personalBankName: 'My Own Bank' })).toMatchObject({ ok: false, errors: { personalBankName: 'Choose your bank from the list.' } });
      expect(checkSubmission(role, { ...coach, personalBankName: 'bank of kigali plc' }).ok).toBe(false);
      expect(checkSubmission(role, { ...coach, schoolBankName: 'Bank of Kigali Plc' })).toMatchObject({ ok: false, errors: { schoolBankName: expect.stringContaining(UMWALIMU_SACCO) } });
      // The personal bank is required (never defaulted for coaches); the 12-digit rule does not apply to them.
      expect(checkSubmission(role, { ...coach, personalBankName: undefined })).toMatchObject({ ok: false, errors: { personalBankName: 'Bank name is required.' } });
      // No format is imposed on a coach's account numbers (only the teachers' 12-digit rule was agreed); kept as given.
      for (const n of ['1', '123456', '00-1234-5678', 'ACC 77']) {
        expect(checkSubmission(role, { ...coach, personalAccountNumber: n })).toMatchObject({ ok: true, values: { personalAccountNumber: n } });
      }
    }
  });

  it('account names: any non-empty name, trimmed at its ends only', () => {
    expect(checkSubmission('MENTOR', { ...coach, personalAccountName: ' J ' })).toMatchObject({ ok: true, values: { personalAccountName: 'J' } });
    expect(checkSubmission('MENTOR', { ...coach, schoolAccountName: '   ' })).toMatchObject({ ok: false, errors: { schoolAccountName: 'School bank account name is required.' } });
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

describe('saved banks that conflict with the rules: never replaced without the user\'s confirmation', () => {
  const kept = { personalAccountName: 'Old Name', personalAccountNumber: '123456789012', schoolAccountName: 'Old School', schoolAccountNumber: '555' };

  it('teacher: a saved personal and school bank other than Umwalimu SACCO are conflicts; the rest is not', () => {
    const saved = { ...kept, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' };
    expect(bankConflicts('TEACHER', saved)).toEqual([{ field: 'personalBankName', saved: 'Bank of Kigali Plc' }, { field: 'schoolBankName', saved: 'Equity Bank Rwanda Plc' }]);
    expect(bankingSummary('TEACHER', saved)).toMatchObject({ status: 'NEEDS_CORRECTION', invalid: ['personalBankName', 'schoolBankName'] });
  });

  it('teacher: without confirmation each conflicting field is refused, named, with the saved value; nothing to save', () => {
    const saved = { ...kept, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' };
    const r = checkSubmission('TEACHER', { ...kept, personalBankName: UMWALIMU_SACCO }, saved, []);
    expect(r).toEqual({
      ok: false,
      errors: { personalBankName: confirmReplaceMessage('Bank of Kigali Plc'), schoolBankName: confirmReplaceMessage('Equity Bank Rwanda Plc') },
      confirmationNeeded: ['personalBankName', 'schoolBankName'],
    });
    // One confirmed, the other not: still refused for the other only.
    const one = checkSubmission('TEACHER', kept, saved, ['personalBankName']);
    expect(one).toMatchObject({ ok: false, confirmationNeeded: ['schoolBankName'] });
    expect(Object.keys((one as { errors: object }).errors)).toEqual(['schoolBankName']);
  });

  it('teacher: confirmed, Umwalimu SACCO replaces both; every other value is kept exactly as sent', () => {
    const saved = { ...kept, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' };
    expect(checkSubmission('TEACHER', kept, saved, ['personalBankName', 'schoolBankName']))
      .toEqual({ ok: true, values: { ...kept, personalBankName: UMWALIMU_SACCO, schoolBankName: UMWALIMU_SACCO } });
  });

  it('coach: a saved school bank other than Umwalimu SACCO needs the confirmation; the personal bank from the list is not a conflict', () => {
    const saved = { ...kept, personalBankName: 'Ecobank Rwanda Plc', schoolBankName: 'Bank of Kigali Plc' };
    expect(bankConflicts('MENTOR', saved)).toEqual([{ field: 'schoolBankName', saved: 'Bank of Kigali Plc' }]);
    expect(checkSubmission('HEAD_COACH', { ...kept, personalBankName: 'Ecobank Rwanda Plc' }, saved, [])).toMatchObject({ ok: false, confirmationNeeded: ['schoolBankName'] });
    expect(checkSubmission('HEAD_COACH', { ...kept, personalBankName: 'Ecobank Rwanda Plc' }, saved, ['schoolBankName']))
      .toEqual({ ok: true, values: { ...kept, personalBankName: 'Ecobank Rwanda Plc', schoolBankName: UMWALIMU_SACCO } });
  });

  it('a confirmation never lets another bank through: sending a non-Umwalimu bank for a fixed field is refused', () => {
    const saved = { ...kept, personalBankName: 'Bank of Kigali Plc', schoolBankName: UMWALIMU_SACCO };
    expect(checkSubmission('TEACHER', { ...kept, personalBankName: 'Bank of Kigali Plc' }, saved, ['personalBankName']))
      .toMatchObject({ ok: false, errors: { personalBankName: `Teachers' personal bank is ${UMWALIMU_SACCO}.` } });
  });

  it('no conflict, no confirmation needed (a first submission, or saved banks already Umwalimu SACCO)', () => {
    expect(checkSubmission('TEACHER', kept, null, [])).toMatchObject({ ok: true });
    expect(checkSubmission('TEACHER', kept, { personalBankName: UMWALIMU_SACCO, schoolBankName: UMWALIMU_SACCO }, [])).toMatchObject({ ok: true });
  });
});
