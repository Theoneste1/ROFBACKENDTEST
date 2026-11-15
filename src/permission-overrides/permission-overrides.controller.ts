import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../common/auth-user.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { CreateOverrideDto } from './dto/create-override.dto.js';
import { PermissionOverridesService } from './permission-overrides.service.js';

/**
 * Individual permission overrides (P1-09). Changing them: Super Admin only
 * (permissions.manageOverrides). Reading effective permissions and the
 * catalogue: permissions.view (Administrators and Super Admins).
 */
@ApiTags('Admin · Permissions')
@ApiBearerAuth()
@Controller('admin')
export class PermissionOverridesController {
  constructor(private readonly service: PermissionOverridesService) {}

  /** The user's overrides, newest first (active and past). */
  @Get('users/:id/permission-overrides')
  @RequirePermission('permissions.manageOverrides')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.list(id);
  }

  /** Add an override, validated against the approved list (400 OVERRIDE_NOT_ALLOWED otherwise). */
  @Post('users/:id/permission-overrides')
  @RequirePermission('permissions.manageOverrides')
  create(@Param('id', ParseUUIDPipe) id: string, @Body() body: CreateOverrideDto, @CurrentUser() user: AuthUser) {
    return this.service.create(id, body, user);
  }

  /** Revoke an override (soft; history kept). Applies on the user's next request. */
  @Delete('users/:id/permission-overrides/:overrideId')
  @RequirePermission('permissions.manageOverrides')
  revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('overrideId', ParseUUIDPipe) overrideId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.revoke(id, overrideId, user);
  }

  /** What the user can do now: role defaults with their active overrides applied. */
  @Get('users/:id/permissions')
  @RequirePermission('permissions.view')
  effective(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.effectiveFor(id);
  }

  /** The permission catalogue, role defaults and the override policy (defined in code). */
  @Get('permissions/catalogue')
  @RequirePermission('permissions.view')
  catalogue() {
    return this.service.catalogue();
  }
}
