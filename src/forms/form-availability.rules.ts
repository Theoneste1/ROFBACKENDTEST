/**
 * Form availability: the pure rules (no database, no clock), unit-tested in form-availability.rules.spec.ts and
 * documented in docs/operations/forms.md.
 *
 * Every form has a mode:
 *   OPEN       open now, until `closesAt` if one is set (then ENDED). `opensAt` is ignored.
 *   CLOSED     closed. The dates are kept but ignored.
 *   SCHEDULED  open from `opensAt` (inclusive) to `closesAt` (exclusive); without `closesAt` it stays open.
 *              Before `opensAt`: NOT_YET_OPEN. From `closesAt` on: ENDED.
 *
 * Times are UTC instants; they are SHOWN in Africa/Kigali (UTC+2, no daylight saving). A state is computed on
 * every request from the stored row and the current time, so editing or removing a date takes effect at once.
 */
import type { FormKey, FormMode } from '../generated/prisma/client.js';

export const FORM_KEYS = ['STUDENT_REGISTRATION', 'TEACHER_REGISTRATION', 'COACH_APPLICATION', 'CONTACT'] as const satisfies readonly FormKey[];
export const FORM_MODES = ['OPEN', 'CLOSED', 'SCHEDULED'] as const satisfies readonly FormMode[];

/** OPEN: accepts submissions. CLOSED: closed by an administrator. NOT_YET_OPEN: scheduled, before opensAt. ENDED: closesAt has passed. */
export type FormState = 'OPEN' | 'CLOSED' | 'NOT_YET_OPEN' | 'ENDED';

/** How dates are shown to people (stored and sent as UTC instants). */
export const FORM_TIMEZONE = 'Africa/Kigali';

export interface FormSchedule {
  mode:     FormMode;
  opensAt:  Date | null;
  closesAt: Date | null;
}

export function formState(c: FormSchedule, now: Date): FormState {
  if (c.mode === 'CLOSED') return 'CLOSED';
  if (c.closesAt && now.getTime() >= c.closesAt.getTime()) return 'ENDED';
  // SCHEDULED without an opening time never opens by itself (refused on save; fails closed if stored).
  if (c.mode === 'SCHEDULED' && (!c.opensAt || now.getTime() < c.opensAt.getTime())) return 'NOT_YET_OPEN';
  return 'OPEN';
}

export const isOpen = (c: FormSchedule, now: Date): boolean => formState(c, now) === 'OPEN';

/**
 * The schedule rules a saved configuration must satisfy. Returns the problems (empty when valid). The order of
 * the two dates matters only for SCHEDULED: OPEN ignores opensAt and CLOSED ignores both (they are kept, and are
 * checked again when the form is switched to SCHEDULED).
 */
export function scheduleProblems(c: FormSchedule): string[] {
  const problems: string[] = [];
  if (c.mode === 'SCHEDULED' && !c.opensAt) problems.push('opensAt is required when mode is SCHEDULED.');
  if (c.mode === 'SCHEDULED' && c.opensAt && c.closesAt && c.closesAt.getTime() <= c.opensAt.getTime()) problems.push('closesAt must be after opensAt.');
  return problems;
}

/** Built-in texts, used while the form's own message is not set (null). */
export const FORM_DEFAULTS: Readonly<Record<FormKey, { label: string; closedMessage: string }>> = {
  STUDENT_REGISTRATION: {
    label: 'Student registration',
    closedMessage: 'Student registration is currently closed. Please contact the Rwanda Olympiad Foundation for further information or check back later.',
  },
  TEACHER_REGISTRATION: {
    label: 'Teacher registration',
    closedMessage: 'Teacher registration is currently closed. Please contact the Rwanda Olympiad Foundation for further information or check back later.',
  },
  COACH_APPLICATION: {
    label: 'Coach applications',
    closedMessage: 'Coach applications are currently closed. Please contact the Rwanda Olympiad Foundation for further information or check back later.',
  },
  CONTACT: {
    label: 'Contact form',
    closedMessage: 'The contact form is currently closed. Please contact the Rwanda Olympiad Foundation by e-mail or check back later.',
  },
};

/**
 * "1 December 2026, 08:00 (Kigali time)" — how a time is written in messages. Assembled from the date parts so
 * the text does not depend on the ICU version's sentence pattern.
 */
export function kigaliTime(d: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: FORM_TIMEZONE, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (Kigali time)`;
}
