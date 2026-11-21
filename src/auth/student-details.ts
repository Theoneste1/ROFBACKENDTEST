import { HttpStatus } from '@nestjs/common';

import { AppError } from '../common/errors/app-error.js';
import { normalisePhone } from '../schools/directory/school-contacts.js';
import { RWANDA } from '../schools/school-rules.js';
import { hasHomePlace, type RegisterStudentDto } from './dto/register-student.dto.js';

/**
 * The registration details of a student (capability studentRegistrationDetails) as stored on User:
 * date of birth, own and close-family phones (E.164), own country and the official home place.
 * Validation of each value is in the DTO; this file checks the combinations and builds the columns.
 */

export type HomePlace = { province: string; district: string; sector: string };

/** The official home place sent, or null; refused (400 HOME_LOCATION_RWANDA_ONLY) with another homeCountry. */
export function homePlaceOf(data: RegisterStudentDto): HomePlace | null {
  if (!hasHomePlace(data)) return null;
  if (data.homeCountry !== undefined && data.homeCountry !== RWANDA) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'HOME_LOCATION_RWANDA_ONLY',
      "Province, district and sector are Rwanda's; for another country enter the home city or region (homeLocation).",
      { homeCountry: data.homeCountry });
  }
  return { province: data.homeProvince!, district: data.homeDistrict!, sector: data.homeSector! };
}

/** The 400 for a home place that is not in the official directory. */
export function unknownHomeLocation(p: HomePlace) {
  return new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_HOME_LOCATION',
    `${p.sector}, ${p.district} is not a sector of that district in the official directory.`,
    { province: p.province, district: p.district, sector: p.sector });
}

/** "Sector, District": how homeLocation is kept for existing displays when the official home place is given. */
export const homeLocationText = (p: HomePlace) => `${p.sector}, ${p.district}`;

/** The User columns of the registration details (only those sent; the DTO already validated each value). */
export function studentDetailColumns(data: RegisterStudentDto, home: HomePlace | null) {
  return {
    ...(data.dateOfBirth !== undefined && { dateOfBirth: new Date(`${data.dateOfBirth}T00:00:00Z`) }),
    ...(data.gender !== undefined && { gender: data.gender }),
    ...(data.phone !== undefined && { phone: normalisePhone(data.phone) }),
    ...(data.guardianPhone !== undefined && { guardianPhone: normalisePhone(data.guardianPhone) }),
    ...(data.homeCountry !== undefined && { country: data.homeCountry }),
    ...(home && { homeProvince: home.province, homeDistrict: home.district, homeSector: home.sector }),
    homeLocation: data.homeLocation ?? (home ? homeLocationText(home) : null),
  };
}

/** What the audit log may say about the details: only whether each was given (never a phone or a date). */
export function studentDetailAudit(data: RegisterStudentDto, home: HomePlace | null) {
  return {
    dateOfBirthGiven: data.dateOfBirth !== undefined,
    phoneGiven: data.phone !== undefined,
    guardianPhoneGiven: data.guardianPhone !== undefined,
    ...(data.homeCountry !== undefined && { homeCountry: data.homeCountry }),
    homePlaceGiven: !!home,
  };
}
