import { describe, expect, it } from 'vitest';

import {
  BANKS, DEFAULT_BANKS, GENERAL_NUMBER_MESSAGE, SACCO_NUMBER_MESSAGE, UMWALIMU_SACCO, bankRules, bankingIncomplete, bankingSummary,
  checkSubmission, maskAccountNumber, normalizeBanks, numberInstruction, numberProblem, type BankOption,
} from './banking-rules.js';

const BK = 'Bank of Kigali Plc';
const teacher = (over: Record<string, string> = {}) => ({
  personalAccountName: 'Aline Uwase', personalBankName: UMWALIMU_SACCO, personalAccountNumber: '123456789012',
  schoolAccountName: 'GS Kigali', schoolBankName: UMWALIMU_SACCO, schoolAccountNumber: '210987654321', ...over,
});
const coach = (over: Record<string, string> = {}) => ({
  personalAccountName: 'Jean Mentor', personalBankName: BK, personalAccountNumber: '00040-1234567-89', ...over,
});

describe('bank list (owner 2026-11-27: managed by the Super Administrator)', () => {
  it('starts with the twelve agreed banks; Umwalimu SACCO exactly 12 digits, the others the general check', () => {
    expect(DEFAULT_BANKS.map((b) => b.name)).toEqual([...BANKS]);
    expect(DEFAULT_BANKS.find((b) => b.name === UMWALIMU_SACCO)).toEqual({ name: UMWALIMU_SACCO, active: true, minDigits: 12, maxDigits: 12 });
    expect(DEFAULT_BANKS.filter((b) => b.name !== UMWALIMU_SACCO).every((b) => b.minDigits === null && b.active)).toBe(true);
  });

  it('normalising: names trimmed, duplicates dropped, rules sane, Umwalimu SACCO always kept, available and 12 digits', () => {
    const out = normalizeBanks([
      { name: '  New  Bank ', active: true, minDigits: 14, maxDigits: 10 },
      { name: 'new bank', active: true },
      { name: 'umwalimu sacco', active: false, minDigits: 3, maxDigits: 4 },
      { name: 'Only Min', minDigits: 9 },
      { name: '' },
    ]);
    expect(out).toEqual([
      { name: 'New Bank', active: true, minDigits: 10, maxDigits: 14 },
      { name: UMWALIMU_SACCO, active: true, minDigits: 12, maxDigits: 12 },
      { name: 'Only Min', active: true, minDigits: 9, maxDigits: 9 },
    ]);
    expect(normalizeBanks([{ name: 'X Bank' }]).map((b) => b.name)).toEqual(['X Bank', UMWALIMU_SACCO]);
  });

  it('instructions follow the bank; Umwalimu SACCO says exactly the agreed sentence', () => {
    expect(numberInstruction({ name: UMWALIMU_SACCO, active: true, minDigits: 12, maxDigits: 12 })).toBe('Umwalimu SACCO account numbers must contain exactly 12 digits.');
    expect(numberInstruction({ name: 'X Bank', active: true, minDigits: 10, maxDigits: 10 })).toBe('X Bank account numbers must contain exactly 10 digits.');
    expect(numberInstruction({ name: 'X Bank', active: true, minDigits: 9, maxDigits: 13 })).toBe('X Bank account numbers must contain between 9 and 13 digits.');
    expect(numberInstruction({ name: 'X Bank', active: true, minDigits: null, maxDigits: null })).toBe(GENERAL_NUMBER_MESSAGE);
  });

  it('Umwalimu SACCO: exactly 12 digits — fewer, more, letters or other characters refused', () => {
    const sacco = DEFAULT_BANKS.find((b) => b.name === UMWALIMU_SACCO)!;
    expect(numberProblem(sacco, '123456789012')).toBeNull();
    for (const bad of ['12345678901', '1234567890123', '12345678901a', '1234 5678 9012', '1234-5678-901', 'abcdefghijkl']) {
      expect([bad, numberProblem(sacco, bad)]).toEqual([bad, SACCO_NUMBER_MESSAGE]);
    }
  });

  it('another bank: its own rule, or the general check — never the 12-digit SACCO rule', () => {
    const ten: BankOption = { name: 'Ten Bank', active: true, minDigits: 10, maxDigits: 10 };
    expect(numberProblem(ten, '1234567890')).toBeNull();
    expect(numberProblem(ten, '123456789012')).toBe('Ten Bank account numbers must contain exactly 10 digits.');
    const bk = DEFAULT_BANKS.find((b) => b.name === BK)!;
    expect(numberProblem(bk, '00040-1234567-89')).toBeNull();
    expect(numberProblem(bk, '123')).toBe(GENERAL_NUMBER_MESSAGE);
    expect(numberProblem(bk, 'no-digits-here')).toBe(GENERAL_NUMBER_MESSAGE);
  });

  it('the form rules list every available bank with its instruction (a switched-off bank is not offered)', () => {
    const banks = normalizeBanks([...DEFAULT_BANKS, { name: 'Closed Bank', active: false }]);
    const r = bankRules('TEACHER', banks);
    expect(r.personalBank).toBe('LIST');
    expect(r.schoolBank).toBe('LIST');
    expect(r.banks).toContain(BK);
    expect(r.banks).not.toContain('Closed Bank');
    expect(r.bankOptions.find((b) => b.name === UMWALIMU_SACCO)!.instruction).toBe(SACCO_NUMBER_MESSAGE);
    expect(r.schoolRequired).toBe(true);
    expect(bankRules('MENTOR').schoolRequired).toBe(false);
  });
});

describe('completion (the sign-in lock) uses only stable rules — editing the bank list never locks anyone out', () => {
  it('teacher with Umwalimu SACCO 12-digit numbers: complete; with another bank chosen: complete too', () => {
    expect(bankingSummary('TEACHER', teacher()).status).toBe('COMPLETE');
    expect(bankingSummary('TEACHER', teacher({ personalBankName: BK, personalAccountNumber: '00040-1234567-89' })).status).toBe('COMPLETE');
  });

  it('a saved Umwalimu SACCO number that is not 12 digits, or a name with digits: NEEDS_CORRECTION (never changed)', () => {
    expect(bankingSummary('TEACHER', teacher({ personalAccountNumber: '12345' }))).toMatchObject({ status: 'NEEDS_CORRECTION', invalid: ['personalAccountNumber'] });
    expect(bankingSummary('MENTOR', coach({ personalAccountName: 'Jean 2' }))).toMatchObject({ status: 'NEEDS_CORRECTION', invalid: ['personalAccountName'] });
  });

  it('missing fields: NOT_STARTED / PARTIAL; coaches are never asked school details; students are not asked', () => {
    expect(bankingSummary('TEACHER', null).status).toBe('NOT_STARTED');
    expect(bankingSummary('TEACHER', { personalAccountName: 'A B' }).status).toBe('PARTIAL');
    expect(bankingSummary('MENTOR', coach()).status).toBe('COMPLETE');
    expect(bankingSummary('STUDENT', null)).toEqual({ required: false, status: null, missing: [], invalid: [] });
    expect(bankingIncomplete('HEAD_COACH', coach())).toBe(false);
  });
});

describe("a submission (own form and an administrator's edit)", () => {
  it('teacher: banks chosen from the list; Umwalimu SACCO numbers exactly 12 digits', () => {
    expect(checkSubmission('TEACHER', teacher())).toEqual({ ok: true, values: teacher() });
    const r = checkSubmission('TEACHER', teacher({ personalAccountNumber: '1234567890123', schoolAccountNumber: '12345678901a' }));
    expect(r).toMatchObject({ ok: false, errors: { personalAccountNumber: SACCO_NUMBER_MESSAGE, schoolAccountNumber: SACCO_NUMBER_MESSAGE } });
  });

  it('teacher: another bank is accepted with its own rule — the 12-digit rule follows Umwalimu SACCO only', () => {
    const r = checkSubmission('TEACHER', teacher({ personalBankName: BK, personalAccountNumber: '00040-1234567-89' }));
    expect(r).toEqual({ ok: true, values: teacher({ personalBankName: BK, personalAccountNumber: '00040-1234567-89' }) });
    const ten = normalizeBanks([...DEFAULT_BANKS, { name: 'Ten Bank', minDigits: 10, maxDigits: 10 }]);
    expect(checkSubmission('TEACHER', teacher({ schoolBankName: 'Ten Bank', schoolAccountNumber: '123456789012' }), null, [], ten))
      .toMatchObject({ ok: false, errors: { schoolAccountNumber: 'Ten Bank account numbers must contain exactly 10 digits.' } });
  });

  it('a bank not on the list, or switched off, is refused — unless it is the one already saved', () => {
    expect(checkSubmission('MENTOR', coach({ personalBankName: 'Unknown Bank' }))).toMatchObject({ ok: false, errors: { personalBankName: 'Choose the bank from the list.' } });
    const closed = normalizeBanks([...DEFAULT_BANKS, { name: 'Closed Bank', active: false }]);
    expect(checkSubmission('MENTOR', coach({ personalBankName: 'Closed Bank', personalAccountNumber: '12345678' }), null, [], closed))
      .toMatchObject({ ok: false, errors: { personalBankName: 'Closed Bank can no longer be chosen. Choose another bank from the list.' } });
    const saved = coach({ personalBankName: 'Closed Bank', personalAccountNumber: '12345678' });
    expect(checkSubmission('MENTOR', saved, saved, [], closed)).toEqual({ ok: true, values: saved });
  });

  it('a number kept unchanged with its bank is never refused by a rule added later', () => {
    const strict = normalizeBanks(DEFAULT_BANKS.map((b) => (b.name === BK ? { ...b, minDigits: 13, maxDigits: 13 } : b)));
    const saved = coach();
    expect(checkSubmission('MENTOR', saved, saved, [], strict)).toEqual({ ok: true, values: saved });
    expect(checkSubmission('MENTOR', coach({ personalAccountNumber: '123' }), saved, [], strict))
      .toMatchObject({ ok: false, errors: { personalAccountNumber: `${BK} account numbers must contain exactly 13 digits.` } });
  });

  it('coaches: only the three personal fields are checked and saved; school fields sent are ignored', () => {
    const r = checkSubmission('HEAD_COACH', { ...coach(), schoolAccountName: 'X', schoolBankName: 'Nope', schoolAccountNumber: '1' });
    expect(r).toEqual({ ok: true, values: coach() });
  });

  it('required fields and names without digits; names trimmed, nothing else changed', () => {
    expect(checkSubmission('TEACHER', teacher({ schoolBankName: '' }))).toMatchObject({ ok: false, errors: { schoolBankName: 'Choose the bank from the list.' } });
    expect(checkSubmission('TEACHER', teacher({ personalAccountName: 'Aline 7' }))).toMatchObject({ ok: false, errors: { personalAccountName: expect.stringContaining('must not contain numbers') } });
    expect(checkSubmission('MENTOR', coach({ personalAccountName: '  Jean Mentor  ' }))).toEqual({ ok: true, values: coach() });
  });

  it('masking keeps only the last four characters', () => {
    expect(maskAccountNumber('123456789012')).toBe('•••• 9012');
    expect(maskAccountNumber(null)).toBeNull();
  });
});
