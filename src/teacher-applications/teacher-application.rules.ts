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
  new AppError(HttpStatus.FORBIDDEN, 'REGISTRATION_CLOSED', 'Teacher registration is closed at the moment. Please check back later or contact the Rwanda Olympiad Foundation.');

export type SchoolChoice =
  | { kind: 'LISTED'; schoolId: string }
  | {
      kind: 'MISSING'; proposedSchoolName: string; schoolSector: string;
      /** The school's official details (owner 2026-11-22): code, ownership and day / boarding required; cell, village optional. */
      code: string; cell: string | null; village: string | null; ownership: string; accommodation: 'DAY' | 'BOARDING' | 'MIXED';
    };

type ChoiceInput = {
  schoolId?: string; proposedSchoolName?: string; schoolSector?: string;
  proposedSchoolCode?: string; proposedSchoolCell?: string; proposedSchoolVillage?: string;
  proposedSchoolOwnership?: string; proposedSchoolAccommodation?: 'DAY' | 'BOARDING' | 'MIXED';
};

/** Exactly one of schoolId / proposedSchoolName (400 SCHOOL_CHOICE_REQUIRED otherwise). */
export function schoolChoice(dto: ChoiceInput): SchoolChoice {
  const listed = dto.schoolId !== undefined;
  const missing = dto.proposedSchoolName !== undefined;
  const details = [dto.schoolSector, dto.proposedSchoolCode, dto.proposedSchoolCell, dto.proposedSchoolVillage, dto.proposedSchoolOwnership, dto.proposedSchoolAccommodation];
  // A listed school's sector and details come from the directory, never from the client.
  if (listed === missing || (listed && details.some((d) => d !== undefined))) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_CHOICE_REQUIRED',
      'Choose your school from the list, or choose “My school is not listed” and give its details (only one of the two).');
  }
  if (listed) return { kind: 'LISTED', schoolId: dto.schoolId! };
  return {
    kind: 'MISSING', proposedSchoolName: dto.proposedSchoolName!, schoolSector: dto.schoolSector!,
    code: dto.proposedSchoolCode!, cell: dto.proposedSchoolCell ?? null, village: dto.proposedSchoolVillage ?? null,
    ownership: dto.proposedSchoolOwnership!, accommodation: dto.proposedSchoolAccommodation!,
  };
}

export function assertPasswordsMatch(password: string, confirmPassword: string): void {
  if (password !== confirmPassword) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'PASSWORD_MISMATCH', 'The two passwords are not the same. Type the same password in both fields.');
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
        'This applicant chose a school from the official list. Approve the application with that school.',
        { applicationSchoolId });
    }
    return applicationSchoolId;
  }
  if (requested === undefined) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_REQUIRED',
      'This applicant\'s school is not in the official list yet. Verify the school first (add it, or choose an existing school), then approve.');
  }
  return requested;
}

export const applicationAlreadyDecided = () =>
  new AppError(HttpStatus.CONFLICT, 'APPLICATION_ALREADY_DECIDED', 'This teacher application has already been decided.');

export const identityTaken = () =>
  new AppError(HttpStatus.CONFLICT, 'IDENTITY_TAKEN', 'Username or email is already in use.');

export const unknownSchool = (schoolId: string) =>
  new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_SCHOOL', 'This school cannot be chosen: choose an active school with an official code, or one an administrator has added and verified.', { schoolId });

/** A missing-school application is approved only once an Administrator verified its school. */
export const schoolNotVerified = () =>
  new AppError(HttpStatus.BAD_REQUEST, 'SCHOOL_NOT_VERIFIED',
    'This applicant\'s school is missing from the directory: verify it first (POST /admin/teacher-applications/:id/school), then approve.');

/** School verification applies once, and only to a missing-school application. */
export const schoolAlreadyVerified = () =>
  new AppError(HttpStatus.CONFLICT, 'SCHOOL_ALREADY_VERIFIED', 'This application\'s school is already verified.');
