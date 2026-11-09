import { Global, Module } from '@nestjs/common';

import { PermissionService } from './permission.service.js';

/** Provides PermissionService everywhere (permission guard, /me/permissions). */
@Global()
@Module({
  providers: [PermissionService],
  exports:   [PermissionService],
})
export class PermissionsModule {}
