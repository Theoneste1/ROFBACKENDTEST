/**
 * Teacher self-registration (owner-approved): the pure rules, independent of the database.
 *
 *  - registration is open only while the Teacher role is enabled (TEACHERS_ENABLED) AND the
 *    registration.teacherSelfSignup setting is on;
 *  - an application names EITHER a listed school (schoolId) OR a missing one
 *    (proposedSchoolName + schoolSector), never both and never neither;
 *  - the approval assigns the application's own listed school (an Administrator may repeat it, never
 *    change it); a missing-school application needs the school the Administrator chose or created.
 */
import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';

/** Open only when both switches are on (both default off). */
export function teacherRegistrationOpen(teachersEnabled: boolean, selfSignupSetting: boolean): boolean {
  return teachersEnabled && selfSignupSetting;
}

export const registrationClosed = () =>
  new AppError(HttpStatus.FORBIDDEN, 'REGISTRATION_CLOSED', 'Teacher registration is currently closed.');

export type SchoolChoice =
  | { kind: 'LISTED'; schoolId: string }
  | { kind: 'MISSING'; proposedSchoolName: string; schoolSector: string };

/** Exactly one of schoolId / proposedSchoolName (400 SCHOOL_CHOICE_REQUIRED otherwise). */
export function schoolChoice(dto: { schoolId?: string; proposedSchoolName?: string; schoolSector?: string }): SchoolChoice {
  const listed = dto.schoolId !== undefined;
  const missing = dto.proposedSchoolName !== undefined;
  // A listed school's sector comes from the directory, never from the client.
  if (listed === missing || (listed && dto.schoolSector !== undefined)) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_CHOICE_REQUIRED',
      'Choose your school from the list (schoolId), or name a missing school (proposedSchoolName with its sector) — exactly one.');
  }
  if (listed) return { kind: 'LISTED', schoolId: dto.schoolId! };
  return { kind: 'MISSING', proposedSchoolName: dto.proposedSchoolName!, schoolSector: dto.schoolSector! };
}

export function assertPasswordsMatch(password: string, confirmPassword: string): void {
  if (password !== confirmPassword) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'PASSWORD_MISMATCH', 'The two passwords do not match.');
  }
}

/**
 * The school an approval assigns. A listed-school application: its own school (a schoolId sent must
 * equal it — 400 SCHOOL_MISMATCH). A missing-school application: the schoolId the Administrator sends
 * (400 SCHOOL_REQUIRED without one).
 */
export function approvalSchoolId(applicationSchoolId: string | null, requested: string | undefined): string {
  if (applicationSchoolId) {
    if (requested !== undefined && requested !== applicationSchoolId) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_MISMATCH',
        'This application names a listed school; approve it with that school (or without schoolId).',
        { applicationSchoolId });
    }
    return applicationSchoolId;
  }
  if (requested === undefined) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_REQUIRED',
      'This applicant\'s school is missing from the directory: create it (POST /admin/schools) or choose an existing school, then approve with its schoolId.');
  }
  return requested;
}

export const applicationAlreadyDecided = () =>
  new AppError(HttpStatus.CONFLICT, 'APPLICATION_ALREADY_DECIDED', 'This teacher application has already been decided.');

export const identityTaken = () =>
  new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');

export const unknownSchool = (schoolId: string) =>
  new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL', 'This school is not an active school of the official directory.', { schoolId });
