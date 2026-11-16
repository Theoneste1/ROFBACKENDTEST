import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { ApiBody, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { SettingsService } from './settings.service.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Admin · Settings')
@Controller('admin/settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * All settings by category (registration, assignments, notification rules,
   * platform, support) with current value, default, type,
   * limits and who changed it last. Academic years are managed under
   * /admin/academic-years.
   */
  @Get()
  @RequirePermission('settings.manage')
  getAll() {
    return this.settings.getAll();
  }

  /**
   * Change one or more settings: `{ "submissions.resubmissionRequestDays": 14 }`. Every change is audited.
   * registration.studentSelfSignup / registration.teacherSelfSignup are form availability switches: writing one
   * also needs forms.manageAvailability (403 PERMISSION_REQUIRED otherwise, and nothing in the request is saved).
   */
  @Patch()
  @ApiBody({ schema: { type: 'object', additionalProperties: true } })
  @RequirePermission('settings.manage')
  update(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.settings.update(body, user, (req as Request & { id?: string }).id ?? null);
  }
}

/** Help and support contact details — public, so the login page can show them. */
@ApiTags('Support')
@Controller('support')
export class SupportController {
  constructor(private readonly settings: SettingsService) {}

  @Public()
  @Get()
  get() {
    return this.settings.supportInfo();
  }
}
