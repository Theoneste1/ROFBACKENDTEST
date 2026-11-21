import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length, Matches, ValidateIf } from 'class-validator';

import { trim } from '../../auth/dto/password.rules.js';

/** GET /admin/countries: part of the name, or the code. */
export class CountryListQueryDto {
  @IsOptional() @IsString() @Length(1, 100) @Transform(trim)
  q?: string;
}

/** PATCH /admin/countries/:code (reference.manage): correct the name or the calling code. Partial. */
export class UpdateCountryDto {
  @IsOptional() @IsString() @Length(2, 100) @Transform(trim)
  name?: string;

  /** International calling code, e.g. "+254"; null removes it. */
  @IsOptional()
  @ValidateIf((o: UpdateCountryDto) => o.phonePrefix !== null)
  @Matches(/^\+\d{1,4}$/, { message: 'phonePrefix must be "+" followed by 1 to 4 digits, e.g. +254.' })
  phonePrefix?: string | null;
}
