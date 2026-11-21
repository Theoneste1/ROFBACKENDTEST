import { Body, Controller, Get, Header, HttpStatus, Injectable, Param, Patch, PipeTransform, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { AppError } from '../common/errors/app-error.js';
import { CountryListQueryDto, UpdateCountryDto } from './dto/reference-data.dto.js';
import { ReferenceDataService } from './reference-data.service.js';

/** An ISO 3166-1 alpha-2 code in the path (any case → upper case); anything else is 404 COUNTRY_NOT_FOUND. */
@Injectable()
export class CountryCodePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!/^[A-Za-z]{2}$/.test(value)) throw new AppError(HttpStatus.NOT_FOUND, 'COUNTRY_NOT_FOUND', `Country "${value}" not found.`);
    return value.toUpperCase();
  }
}

/** Every country, for everyone (no sign-in): the registration and application forms list them (capability `countries`). */
@ApiTags('Countries')
@Controller('countries')
export class CountriesController {
  constructor(private readonly reference: ReferenceDataService) {}

  /** Every ISO 3166-1 alpha-2 country by name: { code, name, phonePrefix }. Reference data only; cached briefly. */
  @Public()
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @Header('Cache-Control', 'public, max-age=60')
  @Get()
  list() {
    return this.reference.countries();
  }
}

/** Administrators correct a country's name or calling code (reference.manage). Every change is audited. */
@ApiTags('Admin · Countries')
@Controller('admin/countries')
export class AdminCountriesController {
  constructor(private readonly reference: ReferenceDataService) {}

  /** Every country with its number of schools and last change (?q= part of the name, or the code). */
  @Get()
  @RequirePermission('reference.manage')
  list(@Query() query: CountryListQueryDto) {
    return this.reference.adminCountries(query.q);
  }

  /** { name?, phonePrefix? } (null removes the calling code). 404 COUNTRY_NOT_FOUND, 400 NO_CHANGES. */
  @Patch(':code')
  @RequirePermission('reference.manage')
  update(@Param('code', CountryCodePipe) code: string, @Body() body: UpdateCountryDto, @CurrentUser() user: AuthUser) {
    return this.reference.updateCountry(code, body, user);
  }
}
