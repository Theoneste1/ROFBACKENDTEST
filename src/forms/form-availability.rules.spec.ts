import { FORM_DEFAULTS, FORM_KEYS, formState, isOpen, kigaliTime, scheduleProblems, type FormSchedule } from './form-availability.rules.js';

const at = (iso: string) => new Date(iso);
const s = (mode: FormSchedule['mode'], opensAt: string | null = null, closesAt: string | null = null): FormSchedule =>
  ({ mode, opensAt: opensAt ? at(opensAt) : null, closesAt: closesAt ? at(closesAt) : null });

describe('form availability rules', () => {
  const NOW = at('2026-12-01T10:00:00.000Z');

  it('CLOSED is closed whatever the dates', () => {
    expect(formState(s('CLOSED'), NOW)).toBe('CLOSED');
    expect(formState(s('CLOSED', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'), NOW)).toBe('CLOSED');
  });

  it('OPEN is open until closesAt (exclusive); opensAt is ignored', () => {
    expect(formState(s('OPEN'), NOW)).toBe('OPEN');
    expect(formState(s('OPEN', '2030-01-01T00:00:00Z'), NOW)).toBe('OPEN');
    expect(formState(s('OPEN', null, '2026-12-01T10:00:00.001Z'), NOW)).toBe('OPEN');
    expect(formState(s('OPEN', null, '2026-12-01T10:00:00.000Z'), NOW)).toBe('ENDED');   // exactly at closesAt
    expect(formState(s('OPEN', null, '2026-11-30T00:00:00Z'), NOW)).toBe('ENDED');
  });

  it('SCHEDULED: NOT_YET_OPEN before opensAt, OPEN from opensAt (inclusive), ENDED from closesAt (inclusive)', () => {
    const w = s('SCHEDULED', '2026-12-01T10:00:00.000Z', '2026-12-02T10:00:00.000Z');
    expect(formState(w, at('2026-12-01T09:59:59.999Z'))).toBe('NOT_YET_OPEN');
    expect(formState(w, at('2026-12-01T10:00:00.000Z'))).toBe('OPEN');      // exactly at opensAt
    expect(formState(w, at('2026-12-02T09:59:59.999Z'))).toBe('OPEN');
    expect(formState(w, at('2026-12-02T10:00:00.000Z'))).toBe('ENDED');     // exactly at closesAt
  });

  it('SCHEDULED without closesAt stays open; without opensAt never opens (fails closed)', () => {
    expect(formState(s('SCHEDULED', '2026-11-01T00:00:00Z'), NOW)).toBe('OPEN');
    expect(formState(s('SCHEDULED', '2027-11-01T00:00:00Z'), NOW)).toBe('NOT_YET_OPEN');
    expect(formState(s('SCHEDULED'), NOW)).toBe('NOT_YET_OPEN');
    expect(isOpen(s('SCHEDULED'), NOW)).toBe(false);
  });

  it('Kigali midnight is 22:00 UTC the day before: a form opening "1 December 00:00 Kigali" opens at 2026-11-30T22:00Z', () => {
    const kigaliMidnight = s('SCHEDULED', '2026-11-30T22:00:00.000Z');
    expect(formState(kigaliMidnight, at('2026-11-30T21:59:59.999Z'))).toBe('NOT_YET_OPEN');   // 23:59:59 in Kigali
    expect(formState(kigaliMidnight, at('2026-11-30T22:00:00.000Z'))).toBe('OPEN');           // 00:00 in Kigali
    expect(kigaliTime(at('2026-11-30T22:00:00.000Z'))).toBe('1 December 2026, 00:00 (Kigali time)');
    expect(kigaliTime(at('2026-12-01T21:59:00.000Z'))).toBe('1 December 2026, 23:59 (Kigali time)');
  });

  it('schedule validation: SCHEDULED needs opensAt; closesAt must be after opensAt', () => {
    expect(scheduleProblems(s('SCHEDULED'))).toEqual(['opensAt is required when mode is SCHEDULED.']);
    expect(scheduleProblems(s('SCHEDULED', '2026-12-01T00:00:00Z', '2026-12-01T00:00:00Z'))).toEqual(['closesAt must be after opensAt.']);
    // OPEN ignores opensAt, so a kept opening date never blocks closing an open form earlier.
    expect(scheduleProblems(s('OPEN', '2026-12-02T00:00:00Z', '2026-12-01T00:00:00Z'))).toEqual([]);
    expect(scheduleProblems(s('SCHEDULED', '2026-12-02T00:00:00Z', '2026-12-01T00:00:00Z'))).toEqual(['closesAt must be after opensAt.']);
    expect(scheduleProblems(s('SCHEDULED', '2026-12-01T00:00:00Z', '2026-12-02T00:00:00Z'))).toEqual([]);
    expect(scheduleProblems(s('OPEN'))).toEqual([]);
    expect(scheduleProblems(s('CLOSED'))).toEqual([]);
  });

  it('every form has a label and a default closed message; the student one is the owner-approved text', () => {
    for (const k of FORM_KEYS) expect(FORM_DEFAULTS[k].closedMessage.length).toBeGreaterThan(20);
    expect(FORM_DEFAULTS.STUDENT_REGISTRATION.closedMessage).toBe(
      'Student registration is currently closed. Please contact the Rwanda Olympiad Foundation for further information or check back later.');
  });
});
