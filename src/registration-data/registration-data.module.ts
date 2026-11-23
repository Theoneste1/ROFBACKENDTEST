import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module.js';
import { FieldCatalogueService } from './field-catalogue.service.js';
import { RegistrationDataController } from './registration-data.controller.js';
import { RegistrationDataService } from './registration-data.service.js';
import { SavedViewsService } from './saved-views.service.js';

@Module({
  imports: [UsersModule],
  controllers: [RegistrationDataController],
  providers: [FieldCatalogueService, RegistrationDataService, SavedViewsService],
})
export class RegistrationDataModule {}
