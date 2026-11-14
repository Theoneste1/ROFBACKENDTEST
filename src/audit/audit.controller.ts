import { Controller, Get, Header, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiProduces, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import type { Response } from 'express';

import { AuditQueryService } from './audit-query.service.js';
import { AuditService } from './audit.service.js';
import { AUDIT_CATEGORY_NAMES, type AuditCategory } from './audit-categories.js';
import { RequirePermission } from '../auth/decorators/require-permission.decorator.js';
import { CurrentUser } from '../common/decorators/current-user.decorator.js';
import { PaginationQueryDto } from '../common/pagination.js';
import type { AuthUser } from '../common/auth-user.js';
import { Role } from '../generated/prisma/client.js';
import { sendCsvExport } from '../reports/csv-stream.js';

class AuditQueryDto extends PaginationQueryDto {
  /** USERS, ENROLLMENT, MENTOR_ASSIGNMENTS, ASSIGNMENTS, DISTRIBUTION, REVIEWS, RESULTS, MODERATION, SETTINGS, … */
  @IsOptional()
  @IsIn(AUDIT_CATEGORY_NAMES, { message: `category must be one of: ${AUDIT_CATEGORY_NAMES.join(', ')}` })
  category?: AuditCategory;

  /** Action name contains (case-insensitive), e.g. "PUBLISH". */
  @IsOptional() @IsString() @Length(1, 100) action?: string;

  /** Who acted. */
  @IsOptional() @IsUUID() actorId?: string;
  @IsOptional() @IsEnum(Role) actorRole?: Role;

  /** The affected record: its type (e.g. "User", "Submission", "SystemSetting") and id. */
  @IsOptional() @IsString() @Length(1, 100) entity?: string;
  @IsOptional() @IsString() @Length(1, 200) entityId?: string;

  /** ISO 8601; a plain date covers that whole day. */
  @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @IsOptional() @IsISO8601({ strict: true }) to?: string;
}

/**
 * The audit trail — administrators only, read-only. There are no routes that
 * create, change or delete audit records, and the database rejects changes.
 */
@ApiTags('Admin · Audit')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(
    private readonly query: AuditQueryService,
    private readonly audit: AuditService,
  ) {}

  /** Newest first; filter by category, action, actor, record and date range. */
  @Get()
  @RequirePermission('audit.view')
  findAll(@Query() q: AuditQueryDto) {
    return this.query.list(q);
  }

  /** Every action with its category and how many times it was recorded (for filters). */
  @Get('actions')
  @RequirePermission('audit.view')
  actions() {
    return this.query.actions();
  }

  /** The filtered trail as CSV, streamed (no row limit; was 50 000). The export itself is audited. */
  @Get('export.csv')
  @ApiProduces('text/csv')
  @Header('Cache-Control', 'no-store')
  @RequirePermission('audit.view')
  async export(@Query() q: AuditQueryDto, @CurrentUser() user: AuthUser, @Res() res: Response) {
    const csv = await this.query.csv(q);
    await this.audit.log({
      actorId: user.id, actorRole: user.role, action: 'EXPORT_AUDIT_LOG', entity: 'AuditLog', metadata: { filters: { ...q } },
    });
    const date = new Date().toISOString().slice(0, 10);
    await sendCsvExport(res, `audit-log-${date}.csv`, csv);
  }

  @Get(':id')
  @RequirePermission('audit.view')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.query.findOne(id);
  }
}
