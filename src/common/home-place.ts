import { HttpStatus } from '@nestjs/common';
import { ValidateIf } from 'class-validator';

import { AppError } from './errors/app-error.js';
import { publicDirectoryHasPlace } from '../schools/school-directory.js';
import { RWANDA } from '../schools/school-rules.js';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * Home location (capability homeLocationRules; owner, 2026-11-20), the same rule on every registration form (student,
 * teacher, coach) and on profile edits:
 *
 *   - the home country is required (ISO 3166-1 alpha-2);
 *   - home country Rwanda → home province, district and sector are required: a place of the official directory
 *     (GET /schools/locations), else 400 UNKNOWN_HOME_LOCATION;
 *   - any other country → no province, district or sector (sent anyway: 400 HOME_LOCATION_RWANDA_ONLY).
 *
 * Home location is separate from the school location: nothing here reads or changes a school.
 */

export interface HomePlaceFields {
  homeProvince?: string | null;
  homeDistrict?: string | null;
  homeSector?: string | null;
}

/** True when any part of the home place is sent. */
export const sendsHomePlace = (o: HomePlaceFields) =>
  (o.homeProvince ?? undefined) !== undefined || (o.homeDistrict ?? undefined) !== undefined || (o.homeSector ?? undefined) !== undefined;

/**
 * For the three place fields of a DTO whose home country is in `countryKey`: validated (so required) when the home
 * country is Rwanda or any part of the place is sent; a missing one is then 400 naming the field.
 */
export const HomePlacePart = (countryKey: string) =>
  ValidateIf((o: Record<string, unknown>) => o[countryKey] === RWANDA || sendsHomePlace(o as HomePlaceFields));

/** The stored home columns: the place in Rwanda, nothing elsewhere. */
export interface HomeColumns {
  country: string;
  homeProvince: string | null;
  homeDistrict: string | null;
  homeSector: string | null;
}

/** "Sector, District": how homeLocation is kept for existing displays when the official home place is given. */
export const homePlaceText = (c: Pick<HomeColumns, 'homeDistrict' | 'homeSector'>) =>
  c.homeDistrict && c.homeSector ? `${c.homeSector}, ${c.homeDistrict}` : null;

/**
 * The home columns for a home country and place that passed the DTO rules, checked against the official directory.
 * Throws 400 HOME_LOCATION_RWANDA_ONLY (a place with another country), 400 HOME_PLACE_REQUIRED (Rwanda without the
 * whole place: a caller that skipped the DTO rule) or 400 UNKNOWN_HOME_LOCATION.
 */
export async function resolveHomePlace(db: Pick<Prisma.TransactionClient, 'school'>, country: string, place: HomePlaceFields): Promise<HomeColumns> {
  const province = place.homeProvince ?? undefined;
  const district = place.homeDistrict ?? undefined;
  const sector = place.homeSector ?? undefined;
  if (country !== RWANDA) {
    if (sendsHomePlace(place)) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'HOME_LOCATION_RWANDA_ONLY',
        'Home province, district and sector are asked only when the home country is Rwanda.', { homeCountry: country });
    }
    return { country, homeProvince: null, homeDistrict: null, homeSector: null };
  }
  if (!province || !district || !sector) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'HOME_PLACE_REQUIRED', 'With Rwanda as the home country, choose the home province, district and sector.');
  }
  if (!(await publicDirectoryHasPlace(db, { province, district, sector }))) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'UNKNOWN_HOME_LOCATION',
      `${sector}, ${district} (${province}) is not a sector of that district in the official directory.`,
      { province, district, sector });
  }
  return { country, homeProvince: province, homeDistrict: district, homeSector: sector };
}
