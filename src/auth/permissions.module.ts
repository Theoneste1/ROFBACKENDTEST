import { Global, Module } from '@nestjs/common';

import { PermissionService } from './permission.service.js';
import { RoleAssignmentPolicy } from './role-assignment.policy.js';

/** Provides PermissionService and the role allow-list everywhere. */
@Global()
@Module({
  providers: [PermissionService, RoleAssignmentPolicy],
  exports:   [PermissionService, RoleAssignmentPolicy],
})
export class PermissionsModule {}
