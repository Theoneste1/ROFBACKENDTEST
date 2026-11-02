import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';

import { SettingsService } from './settings.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Admin · Settings')
@Controller('admin/settings')
@Roles('ADMIN')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /** All settings with current value, default, type and description. */
  @Get()
  getAll() {
    return this.settings.getAll();
  }

  /** Change one or more settings: `{ "registration.studentSelfSignup": false }`. */
  @Patch()
  @ApiBody({ schema: { type: 'object', additionalProperties: true } })
  update(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser) {
    return this.settings.update(body, user);
  }
}
