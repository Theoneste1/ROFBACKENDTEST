import { Module } from '@nestjs/common';

import { AdminCountriesController, CountriesController, CountryCodePipe } from './reference-data.controller.js';
import { ReferenceDataService } from './reference-data.service.js';

/** Countries (design area 1 as simplified by the owner, 2026-11-19). */
@Module({
  controllers: [CountriesController, AdminCountriesController],
  providers:   [ReferenceDataService, CountryCodePipe],
})
export class ReferenceDataModule {}
