import { Global, Module } from '@nestjs/common';

import { AdminFormsController, FormKeyPipe, FormsController } from './form-availability.controller.js';
import { FormAvailabilityService } from './form-availability.service.js';

/** Form availability (registration and website forms). Global: the registration services check it. */
@Global()
@Module({
  controllers: [FormsController, AdminFormsController],
  providers:   [FormAvailabilityService, FormKeyPipe],
  exports:     [FormAvailabilityService],
})
export class FormsModule {}
