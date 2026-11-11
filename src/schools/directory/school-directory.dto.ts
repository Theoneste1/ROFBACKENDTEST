import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches, ValidateNested,
} from 'class-validator';

import { SchoolContactType, SchoolContactVisibility } from '../../generated/prisma/client.js';
import { PRINTABLE } from '../dto/admin-school.dto.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

export const MAX_CONTACTS = 20;
export const MAX_PROGRAMMES = 100;

export class ContactInputDto {
  /** An existing contact of this school (keeps its verification while its type and value are unchanged); omit for a new one. */
  @IsOptional() @IsUUID() id?: string;
  @IsEnum(SchoolContactType) type: SchoolContactType;
  /** E-mail, phone (normalised to E.164; Rwanda: 07… → +2507…) or other text. */
  @IsString() @Length(1, 200) @Matches(PRINTABLE) value: string;
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) @Matches(PRINTABLE) label?: string;
  /** At most one primary contact per type. */
  @IsOptional() @IsBoolean() isPrimary?: boolean;
}

/**
 * PUT /admin/schools/:id/contacts — the school's complete contact list. Contacts left out are
 * removed; a changed type or value loses its verification (back to ADMIN_ONLY).
 */
export class PutSchoolContactsDto {
  @IsArray() @ArrayMaxSize(MAX_CONTACTS) @ValidateNested({ each: true }) @Type(() => ContactInputDto)
  contacts: ContactInputDto[];

  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) reason?: string;
}

/** POST /admin/schools/:id/contacts/:contactId/verify */
export class VerifySchoolContactDto {
  /**
   * ADMIN_ONLY (default): verified, still visible to Administrators only. REPRESENTATIVES: also
   * authorised for the school's representatives (S3). Sending ADMIN_ONLY withdraws that authorisation.
   */
  @IsOptional() @IsIn(Object.values(SchoolContactVisibility)) visibility?: SchoolContactVisibility;

  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) reason?: string;
}

export class LevelInputDto {
  /** An education level code (GET /admin/schools/reference-data). */
  @Transform(upper) @IsString() @Length(1, 10) code: string;
  /** A published variant of the level (e.g. "L"). */
  @IsOptional() @Transform(trim) @IsString() @Length(1, 20) @Matches(PRINTABLE) qualifier?: string;
}

export class ProgrammeInputDto {
  @IsUUID() id: string;
}

/** PUT /admin/schools/:id/offerings — the school's complete list of levels and programmes. */
export class PutSchoolOfferingsDto {
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => LevelInputDto)
  levels: LevelInputDto[];

  @IsArray() @ArrayMaxSize(MAX_PROGRAMMES) @ValidateNested({ each: true }) @Type(() => ProgrammeInputDto)
  programmes: ProgrammeInputDto[];

  @IsOptional() @Transform(trim) @IsString() @Length(3, 500) reason?: string;
}
