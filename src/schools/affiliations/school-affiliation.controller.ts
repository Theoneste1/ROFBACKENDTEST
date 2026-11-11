import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RequirePermission } from '../../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../../common/auth-user.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { AffiliationReasonDto, ListAffiliationsDto, MatchAffiliationDto, StudentClaimDto, VerifyAffiliationDto } from './school-affiliation.dto.js';
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

  /**
   * Link a name-only claim (not listed / another country) to an existing school. The claim stays
   * PENDING — verifying is a separate action. Different country: 400; different province /
   * district / sector: needs confirmDifferentPlace. Create a missing school first with POST /admin/schools.
   */
  @Post('school-affiliations/:id/match')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  match(@Param('id', ParseUUIDPipe) id: string, @Body() body: MatchAffiliationDto, @CurrentUser() user: AuthUser) {
    return this.service.match(id, body, user);
  }

  /** Reopen the student's current REJECTED or REVOKED claim as a new PENDING claim (reason required). */
  @Post('school-affiliations/:id/reopen')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  reopen(@Param('id', ParseUUIDPipe) id: string, @Body() body: AffiliationReasonDto, @CurrentUser() user: AuthUser) {
    return this.service.reopen(id, body.reason, user);
  }

  /** Schools a name-only claim may be matched to (same normalised name in its country / district). */
  @Get('school-affiliations/:id/candidates')
  @RequirePermission('schools.manage')
  candidates(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.candidates(id);
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

  /**
   * Claim a school: by code, "my school is not listed" (name + province / district / sector), or
   * another country (country + name). Always PENDING until an Administrator verifies it. At most 3
   * requests in 24 hours; 7 days after a rejection or revocation of the same school.
   */
  @Post()
  @Roles('STUDENT')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  request(@Body() body: StudentClaimDto, @CurrentUser() user: AuthUser) {
    return this.service.request(user, body);
  }
}
