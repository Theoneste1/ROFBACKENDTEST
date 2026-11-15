import { ValidateBy, type ValidationOptions } from 'class-validator';

import { DATE_PATTERN, DEFAULT_TIME_ZONE, toZoned } from '../../common/time/zoned-time.js';
import { normalisePhone } from '../../schools/directory/school-contacts.js';

/**
 * Validation rules for the registration details (capabilities studentRegistrationDetails and
 * coachApplicationDetails). Messages start with the property name (`$property …`), like class-validator's
 * own, so a client can place each message beside its field.
 */

/** A student's accepted age range on the day of registration (inclusive). */
export const STUDENT_AGE = { min: 5, max: 30 } as const;

/** Whole years between a "YYYY-MM-DD" birth date and a "YYYY-MM-DD" day (the birthday counts). */
export function ageOn(dateOfBirth: string, today: string): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** True for a real calendar date written "YYYY-MM-DD" (no 2026-02-30). */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Today in Rwanda ("YYYY-MM-DD"): the day registration ages are counted on. */
export const todayInRwanda = (now: Date = new Date()) => toZoned(now, DEFAULT_TIME_ZONE).date;

/** The problem with a date of birth, or null when it is acceptable (a real past date, age 5–30 today). */
export function dateOfBirthProblem(value: unknown, today: string = todayInRwanda()): string | null {
  if (typeof value !== 'string' || !isCalendarDate(value)) return 'must be a real date written YYYY-MM-DD';
  if (value >= today) return 'must be a date in the past';
  const age = ageOn(value, today);
  if (age < STUDENT_AGE.min || age > STUDENT_AGE.max) return `must give an age between ${STUDENT_AGE.min} and ${STUDENT_AGE.max} years`;
  return null;
}

/** A student's date of birth: "YYYY-MM-DD", a real past date, age 5–30 on the day of registration (Rwanda). */
export const IsStudentDateOfBirth = (options?: ValidationOptions) =>
  ValidateBy({
    name: 'isStudentDateOfBirth',
    validator: {
      validate: (value: unknown) => dateOfBirthProblem(value) === null,
      defaultMessage: (args) => `${args?.property ?? 'dateOfBirth'} ${dateOfBirthProblem(args?.value) ?? 'is not valid'}.`,
    },
  }, options);

/** A phone number the backend can store in E.164 (the teacher-application rules: normalisePhone). */
export const IsNormalisablePhone = (options?: ValidationOptions) =>
  ValidateBy({
    name: 'isNormalisablePhone',
    validator: {
      validate: (value: unknown) => typeof value === 'string' && normalisePhone(value) !== null,
      defaultMessage: (args) =>
        `${args?.property ?? 'phone'} must be a valid phone number: 07XXXXXXXX in Rwanda, or +country code and number.`,
    },
  }, options);
