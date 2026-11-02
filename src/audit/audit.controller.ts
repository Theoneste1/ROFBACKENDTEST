import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, IsUUID, Length } from 'class-validator';

import { PrismaService } from '../prisma/prisma.service.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { PaginationQueryDto, pageArgs, paginated } from '../common/pagination.js';
import type { Prisma } from '../generated/prisma/client.js';

class AuditQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  entity?: string;

  @IsOptional()
  @IsUUID()
  entityId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 100)
  action?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;
}

@ApiTags('Admin · Audit')
@Controller('admin/audit-logs')
@Roles('ADMIN')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read audit logs with filters and pagination (max 100 per page).
   * Records are read-only; no create/update/delete routes are exposed.
   */
  @Get()
  async findAll(@Query() query: AuditQueryDto) {
    const { page, limit, skip, take } = pageArgs(query);

    const where: Prisma.AuditLogWhereInput = {
      ...(query.actorId  && { actorId: query.actorId }),
      ...(query.entity   && { entity: query.entity }),
      ...(query.entityId && { entityId: query.entityId }),
      ...(query.action   && { action: { contains: query.action, mode: 'insensitive' } }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to   && { lte: new Date(query.to) }),
        },
      }),
    };

    const [logs, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          actor: { select: { id: true, username: true, firstName: true, lastName: true, role: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginated(logs, total, page, limit);
  }
}
