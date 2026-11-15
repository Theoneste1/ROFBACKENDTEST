import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

import { RequirePermission } from '../../../auth/decorators/require-permission.decorator.js';
import type { AuthUser } from '../../../common/auth-user.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { SchoolSyncApplyService } from './school-sync-apply.service.js';
import { ApplySyncRunDto, ProposeResolutionDto, ResolveAfterApplyDto, SyncDecisionsDto } from './school-sync-review.dto.js';
import { SchoolSyncReviewService } from './school-sync-review.service.js';

/**
 * School directory sync — S2b: review, approval and apply.
 *
 *   schools.manage (Administrators, Super Admins)   summary, categories, decisions, proposals,
 *                                                   recompare
 *   schools.syncDirectory (Super Admins only; never grantable)   approve, apply, resolve after apply
 *
 * Deciding a RESOLVE_CONFLICT change also needs schools.syncDirectory (checked by the service).
 * Only apply and resolve write the directory, each in one locked, audited transaction.
 */
@ApiTags('Admin · School directory sync')
@ApiBearerAuth()
@Controller('admin/school-sync/runs')
export class SchoolSyncReviewController {
  constructor(
    private readonly review: SchoolSyncReviewService,
    private readonly applier: SchoolSyncApplyService,
  ) {}

  /** Counts by outcome, change kind × decision and manual review; what still blocks an apply; who uploaded, decided, approved, applied. */
  @Get(':id/review')
  @RequirePermission('schools.manage')
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.review.summary(id);
  }

  /** Category kinds with their counts and the digest of exactly the list (a category approval sends it back). */
  @Get(':id/categories')
  @RequirePermission('schools.manage')
  categories(@Param('id', ParseUUIDPipe) id: string) {
    return this.review.categories(id);
  }

  /** Record decisions — individual (any kind; CHANGE, ADD_CONTACT, NEW_PLACE only so) or by category (digest-bound). */
  @Post(':id/decisions')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SyncDecisionsDto, @CurrentUser() user: AuthUser) {
    return this.review.decide(id, dto, user);
  }

  /** Propose how a CONFLICT / POSSIBLE_DUPLICATE row is resolved (a Super Admin decides it). */
  @Post(':id/items/:itemId/proposal')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  propose(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: ProposeResolutionDto, @CurrentUser() user: AuthUser) {
    return this.review.propose(id, itemId, dto, user);
  }

  /** Compare the run with the directory again (identical changes keep their decisions). */
  @Post(':id/recompare')
  @HttpCode(200)
  @RequirePermission('schools.manage')
  recompare(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.review.recompare(id, user);
  }

  /** Super Admin: approve the reviewed run; returns the apply token (30 min; any later decision invalidates it). */
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('schools.syncDirectory')
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    return this.review.approve(id, user);
  }

  /** Super Admin: apply the approved changes — one locked, atomic, audited transaction. */
  @Post(':id/apply')
  @HttpCode(200)
  @RequirePermission('schools.syncDirectory')
  apply(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplySyncRunDto, @CurrentUser() user: AuthUser) {
    return this.applier.apply(id, dto, user);
  }

  /** Super Admin, after apply: link an open CONFLICT / POSSIBLE_DUPLICATE row to a school (identifiers only). */
  @Post(':id/items/:itemId/resolve')
  @HttpCode(200)
  @RequirePermission('schools.syncDirectory')
  resolve(@Param('id', ParseUUIDPipe) id: string, @Param('itemId', ParseUUIDPipe) itemId: string, @Body() dto: ResolveAfterApplyDto, @CurrentUser() user: AuthUser) {
    return this.applier.resolveAfterApply(id, itemId, dto, user);
  }
}
