import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../../common/auth-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { AffiliationReasonDto, ListAffiliationsDto, VerifyAffiliationDto } from './school-affiliation.dto.js';
import { SchoolAffiliationService } from './school-affiliation.service.js';

/**
 * Student–school verification (schools.manage: Administrators and Super Admins only).
 * Verifying needs a current PENDING claim with a school; rejecting and revoking need a
 * reason, which the student sees. Every decision is atomic with its audit record.
 */
@ApiTags('Admin · School affiliations')
@ApiBearerAuth()
@Controller('admin')
export class AdminSchoolAffiliationsController {
  constructor(private readonly service: SchoolAffiliationService) {}

  /** Claims (default: current only), filterable by status, school, student and country. */
  @Get('school-affiliations')
  @RequirePermission('schools.manage')
  list(@Query() q: ListAffiliationsDto) {
    return this.service.list(q);
  }

  @Get('school-affiliations/:id')
  @RequirePermission('schools.manage')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  /** Confirm that the student belongs to the claim's school. */
  @Post('school-affiliations/:id/verify')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  verify(@Param('id', ParseUUIDPipe) id: string, @Body() body: VerifyAffiliationDto, @CurrentUser() user: AuthUser) {
    return this.service.verify(id, user, body.note);
  }

  @Post('school-affiliations/:id/reject')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  reject(@Param('id', ParseUUIDPipe) id: string, @Body() body: AffiliationReasonDto, @CurrentUser() user: AuthUser) {
    return this.service.reject(id, user, body.reason);
  }

  /** Withdraw a verification; applies on the next request. */
  @Post('school-affiliations/:id/revoke')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  revoke(@Param('id', ParseUUIDPipe) id: string, @Body() body: AffiliationReasonDto, @CurrentUser() user: AuthUser) {
    return this.service.revoke(id, user, body.reason);
  }

  /** A student's claims, newest first. */
  @Get('users/:id/school-affiliations')
  @RequirePermission('schools.manage')
  history(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.history(id);
  }
}

/** The student's own school verification status. */
@ApiTags('Me')
@ApiBearerAuth()
@Controller('me/school-affiliation')
export class MySchoolAffiliationController {
  constructor(private readonly service: SchoolAffiliationService) {}

  /** Current claim: status, school or entered name, and the reason of a rejection or revocation. */
  @Get()
  @Roles('STUDENT')
  mine(@CurrentUser() user: AuthUser) {
    return this.service.mine(user);
  }
}
