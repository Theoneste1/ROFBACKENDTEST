import { Module } from '@nestjs/common';

import { PermissionOverridesController } from './permission-overrides.controller.js';
import { PermissionOverridesService } from './permission-overrides.service.js';

/** Individual permission overrides (P1-09). PermissionService, Prisma and audit come from global modules. */
@Module({
  controllers: [PermissionOverridesController],
  providers:   [PermissionOverridesService],
  exports:     [PermissionOverridesService],
})
export class PermissionOverridesModule {}
