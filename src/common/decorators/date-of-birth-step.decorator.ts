import { SetMetadata } from '@nestjs/common';

export const BEFORE_DATE_OF_BIRTH_KEY = 'allowedBeforeDateOfBirth';

/**
 * The route stays usable by a student who still has to give their date of birth (owner decision 9.3, 2026-11-18):
 * reading the profile and permissions, giving the date of birth, signing out. Every other route answers
 * 403 DATE_OF_BIRTH_REQUIRED for that student (DateOfBirthGuard).
 */
export const AllowedBeforeDateOfBirth = () => SetMetadata(BEFORE_DATE_OF_BIRTH_KEY, true);
