import { describe, expect, it } from 'vitest';

import {
  BANKS, bankConflicts, bankingIncomplete, bankingRequiredFor, bankingSummary, bankRules, checkSubmission, confirmReplaceMessage,
  maskAccountNumber, requiredFields, TEACHER_NUMBER_MESSAGE, UMWALIMU_SACCO,
} from './banking-rules.js';

const teacher = {
  personalAccountName: 'Jean Uwase', personalBankName: UMWALIMU_SACCO, personalAccountNumber: '123456789012',
  schoolAccountName: 'GS Kigali', schoolBankName: UMWALIMU_SACCO, schoolAccountNumber: '4001234567',
};
/** A coach's three personal fields (the final requirements: no school details for coaches). */
const coach = { personalAccountName: 'Eric Coach', personalBankName: 'Bank of Kigali Plc', personalAccountNumber: '00012345678' };

describe('banking rules: who is asked, and what', () => {
  it('Teachers, Coaches and Head Coaches only', () => {
    for (const r of ['TEACHER', 'MENTOR', 'HEAD_COACH']) expect(bankingRequiredFor(r)).toBe(true);
    for (const r of ['STUDENT', 'ADMIN', 'SUPER_ADMIN', 'UNKNOWN', undefined]) expect(bankingRequiredFor(r)).toBe(false);
    expect(bankingSummary('STUDENT', null)).toEqual({ required: false, status: null, missing: [], invalid: [] });
    expect(bankingIncomplete('ADMIN', null)).toBe(false);
    expect(bankingIncomplete('SUPER_ADMIN', null)).toBe(false);
  });

  it('Teachers give all six fields; Coaches and Head Coaches the three personal ones only', () => {
    expect(requiredFields('TEACHER')).toEqual(['personalAccountName', 'personalBankName', 'personalAccountNumber', 'schoolAccountName', 'schoolBankName', 'schoolAccountNumber']);
    for (const r of ['MENTOR', 'HEAD_COACH']) expect(requiredFields(r)).toEqual(['personalAccountName', 'personalBankName', 'personalAccountNumber']);
  });

  it('the bank list is exactly the owner\'s twelve, Umwalimu SACCO included, names as agreed', () => {
    expect(BANKS).toHaveLength(12);
    expect(BANKS).toContain(UMWALIMU_SACCO);
    expect(BANKS).toContain('Zigama Credit and Savings Bank');
    expect(bankRules('TEACHER')).toMatchObject({ personalBank: 'FIXED', schoolBank: 'FIXED', fixedBank: UMWALIMU_SACCO, banks: [UMWALIMU_SACCO], personalNumberDigits: 12, schoolRequired: true });
    expect(bankRules('MENTOR')).toMatchObject({ personalBank: 'LIST', personalNumberDigits: null, schoolRequired: false, fields: ['personalAccountName', 'personalBankName', 'personalAccountNumber'] });
    expect(bankRules('HEAD_COACH')).toEqual(bankRules('MENTOR'));
  });
});

describe('banking rules: completion (each required field on its own)', () => {
  it('Teacher: complete only with all six; any missing one keeps it incomplete', () => {
    expect(bankingSummary('TEACHER', null)).toMatchObject({ status: 'NOT_STARTED' });
    expect(bankingSummary('TEACHER', null).missing).toHaveLength(6);
    expect(bankingSummary('TEACHER', teacher)).toEqual({ required: true, status: 'COMPLETE', missing: [], invalid: [] });
    for (const f of requiredFields('TEACHER')) {
      expect([f, bankingSummary('TEACHER', { ...teacher, [f]: null }).status]).toEqual([f, 'PARTIAL']);
      expect(bankingIncomplete('TEACHER', { ...teacher, [f]: '  ' })).toBe(true);
    }
  });

  it.each(['MENTOR', 'HEAD_COACH'])('%s: complete with the three personal fields; school details never counted', (role) => {
    expect(bankingSummary(role, coach)).toEqual({ required: true, status: 'COMPLETE', missing: [], invalid: [] });
    expect(bankingIncomplete(role, coach)).toBe(false);
    expect(bankingSummary(role, null)).toMatchObject({ status: 'NOT_STARTED', missing: ['personalAccountName', 'personalBankName', 'personalAccountNumber'] });
    // Missing personal details still prevent completion.
    for (const f of ['personalAccountName', 'personalBankName', 'personalAccountNumber']) {
      expect([f, bankingSummary(role, { ...coach, [f]: null })]).toEqual([f, { required: true, status: 'PARTIAL', missing: [f], invalid: [] }]);
    }
    // Saved school details of any kind (legacy) neither help nor hurt: never missing, never invalid.
    expect(bankingSummary(role, { ...coach, schoolAccountName: 'Old', schoolBankName: 'Bank of Kigali Plc', schoolAccountNumber: '1' }).status).toBe('COMPLETE');
  });

  it('a saved value that breaks the current role\'s rules is NEEDS_CORRECTION (never changed by the system)', () => {
    // A coach's details after the account became a teacher: another bank, an 11-digit number, no school details.
    expect(bankingSummary('TEACHER', coach)).toMatchObject({ status: 'NEEDS_CORRECTION', invalid: ['personalBankName', 'personalAccountNumber'] });
    expect(bankingSummary('MENTOR', { ...coach, personalBankName: 'My Own Bank' })).toMatchObject({ status: 'NEEDS_CORRECTION', invalid: ['personalBankName'] });
  });
});

describe('banking rules: a submission', () => {
  it('Teacher: a valid 12-digit number is accepted; both banks are set to Umwalimu SACCO when not sent', () => {
    expect(checkSubmission('TEACHER', { ...teacher, personalBankName: undefined, schoolBankName: undefined })).toEqual({ ok: true, values: teacher });
  });

  it.each([
    ['11 digits', '12345678901'], ['13 digits', '1234567890123'], ['letters', '12345678901A'], ['spaces', '1234 5678 9012'],
    ['symbols', '123456-789012'], ['empty', ''],
  ])('Teacher: %s refused with the exact message, nothing changed or cut', (_label, n) => {
    const r = checkSubmission('TEACHER', { ...teacher, personalAccountNumber: n });
    expect(r).toMatchObject({ ok: false, errors: { personalAccountNumber: TEACHER_NUMBER_MESSAGE } });
    expect(Object.keys((r as { errors: object }).errors)).toEqual(['personalAccountNumber']);
  });

  it('Teacher: another personal or school bank is refused; the school fields are required', () => {
    const r = checkSubmission('TEACHER', { ...teacher, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' });
    expect(Object.keys((r as { errors: object }).errors).sort()).toEqual(['personalBankName', 'schoolBankName']);
    const noSchool = checkSubmission('TEACHER', { personalAccountName: 'Jean', personalAccountNumber: '123456789012' });
    expect(Object.keys((noSchool as { errors: object }).errors).sort()).toEqual(['schoolAccountName', 'schoolAccountNumber']);
  });

  it('Teacher: no format is imposed on the school number', () => {
    for (const n of ['1', '4001-2345-6789', 'SCH 001 22']) {
      expect(checkSubmission('TEACHER', { ...teacher, schoolAccountNumber: n })).toEqual({ ok: true, values: { ...teacher, schoolAccountNumber: n } });
    }
  });

  it.each(['MENTOR', 'HEAD_COACH'])('%s: only the three personal fields are checked and saved; school fields sent are ignored', (role) => {
    expect(checkSubmission(role, coach)).toEqual({ ok: true, values: coach });
    // School details are not asked: sending them (even invalid ones) changes nothing and refuses nothing.
    expect(checkSubmission(role, { ...coach, schoolAccountName: 'X', schoolBankName: 'Not a bank', schoolAccountNumber: '' })).toEqual({ ok: true, values: coach });
    for (const bank of BANKS) expect(checkSubmission(role, { ...coach, personalBankName: bank }).ok).toBe(true);
    expect(checkSubmission(role, { ...coach, personalBankName: 'My Own Bank' })).toMatchObject({ ok: false, errors: { personalBankName: 'Choose your bank from the list.' } });
    // Missing personal details are refused, each named; no 12-digit rule for coaches.
    expect(Object.keys((checkSubmission(role, {}) as { errors: object }).errors).sort()).toEqual(['personalAccountName', 'personalAccountNumber', 'personalBankName']);
    for (const n of ['1', '00-1234-5678', 'ACC 77']) expect(checkSubmission(role, { ...coach, personalAccountNumber: n })).toMatchObject({ ok: true, values: { personalAccountNumber: n } });
  });

  it('account names: any non-empty name, trimmed at its ends only', () => {
    expect(checkSubmission('MENTOR', { ...coach, personalAccountName: ' J ' })).toMatchObject({ ok: true, values: { personalAccountName: 'J' } });
    expect(checkSubmission('TEACHER', { ...teacher, schoolAccountName: '   ' })).toMatchObject({ ok: false, errors: { schoolAccountName: 'School bank account name is required.' } });
  });
});

describe('saved banks that conflict with the rules: never replaced without the user\'s confirmation', () => {
  const kept = { personalAccountName: 'Old Name', personalAccountNumber: '123456789012', schoolAccountName: 'Old School', schoolAccountNumber: '555' };

  it('teacher: a saved personal and school bank other than Umwalimu SACCO are conflicts', () => {
    const saved = { ...kept, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' };
    expect(bankConflicts('TEACHER', saved)).toEqual([{ field: 'personalBankName', saved: 'Bank of Kigali Plc' }, { field: 'schoolBankName', saved: 'Equity Bank Rwanda Plc' }]);
    expect(bankingSummary('TEACHER', saved)).toMatchObject({ status: 'NEEDS_CORRECTION', invalid: ['personalBankName', 'schoolBankName'] });
  });

  it('teacher: without confirmation each conflicting field is refused, named, with the saved value; one confirmation is not enough', () => {
    const saved = { ...kept, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' };
    expect(checkSubmission('TEACHER', { ...kept, personalBankName: UMWALIMU_SACCO }, saved, [])).toEqual({
      ok: false,
      errors: { personalBankName: confirmReplaceMessage('Bank of Kigali Plc'), schoolBankName: confirmReplaceMessage('Equity Bank Rwanda Plc') },
      confirmationNeeded: ['personalBankName', 'schoolBankName'],
    });
    expect(checkSubmission('TEACHER', kept, saved, ['personalBankName'])).toMatchObject({ ok: false, confirmationNeeded: ['schoolBankName'] });
  });

  it('teacher: confirmed, Umwalimu SACCO replaces both; every other value is kept exactly as sent', () => {
    const saved = { ...kept, personalBankName: 'Bank of Kigali Plc', schoolBankName: 'Equity Bank Rwanda Plc' };
    expect(checkSubmission('TEACHER', kept, saved, ['personalBankName', 'schoolBankName']))
      .toEqual({ ok: true, values: { ...kept, personalBankName: UMWALIMU_SACCO, schoolBankName: UMWALIMU_SACCO } });
  });

  it.each(['MENTOR', 'HEAD_COACH'])('%s: a saved school bank is no conflict (school details are not asked) and stays as it is', (role) => {
    const saved = { ...coach, schoolAccountName: 'Legacy School', schoolBankName: 'Bank of Kigali Plc', schoolAccountNumber: '4002222' };
    expect(bankConflicts(role, saved)).toEqual([]);
    expect(bankingSummary(role, saved).status).toBe('COMPLETE');
    const r = checkSubmission(role, coach, saved, []);
    expect(r).toEqual({ ok: true, values: coach });   // nothing for the school fields: the saved ones are kept
  });

  it('a confirmation never lets another bank through: sending a non-Umwalimu bank for a fixed field is refused', () => {
    const saved = { ...kept, personalBankName: 'Bank of Kigali Plc', schoolBankName: UMWALIMU_SACCO };
    expect(checkSubmission('TEACHER', { ...kept, personalBankName: 'Bank of Kigali Plc' }, saved, ['personalBankName']))
      .toMatchObject({ ok: false, errors: { personalBankName: `Teachers' personal bank is ${UMWALIMU_SACCO}.` } });
  });
});

describe('masking', () => {
  it('only the last 4 characters', () => {
    expect(maskAccountNumber('123456789012')).toBe('•••• 9012');
    expect(maskAccountNumber('123')).toBe('••••');
    expect(maskAccountNumber(null)).toBeNull();
    expect(maskAccountNumber('')).toBeNull();
  });
});
