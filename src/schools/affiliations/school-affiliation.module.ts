import { Global, Module } from '@nestjs/common';

import { AdminSchoolAffiliationsController, MySchoolAffiliationController } from './school-affiliation.controller.js';
import { SchoolAffiliationService } from './school-affiliation.service.js';

/** Student–school affiliation. Global: registration, user management and invitations record claims. */
@Global()
@Module({
  controllers: [AdminSchoolAffiliationsController, MySchoolAffiliationController],
  providers:   [SchoolAffiliationService],
  exports:     [SchoolAffiliationService],
})
export class SchoolAffiliationModule {}
