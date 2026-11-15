import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { DivisionsService } from './divisions.service.js';
import { UpdateDivisionDto } from './dto/update-division.dto.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { Public } from '../common/decorators/public.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import type { AuthUser } from '../common/auth-user.js';

@ApiTags('Divisions')
@Controller()
export class DivisionsController {
  constructor(private readonly divisions: DivisionsService) {}

  /** The two divisions and their grade levels (public — needed by the sign-up form). */
  @Public()
  @Get('divisions')
  findAll() {
    return this.divisions.findAll();
  }

  /** Admin view with student and mentor-assignment counts. */
  @Get('admin/divisions')
  @RequirePermission('divisions.manage')
  findAllAdmin() {
    return this.divisions.findAll(true);
  }

  @Patch('admin/divisions/:id')
  @RequirePermission('divisions.manage')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateDivisionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.divisions.update(id, body, user);
  }
}
