/**
 * Table layouts (owner 2026-11-22): which columns a table shows, in which order.
 *  - Each person may save their own layout per table (it wins), or remove it to get the organization default back.
 *  - Administrators holding settings.manage set the organization default (audited) or remove it (built-in default).
 *  - The effective layout: the person's, else the organization's, else the built-in one — always completed with the
 *    table's current columns (table-columns.completeLayout).
 */
import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../audit/audit.service.js';
import type { CallerCtx } from '../common/auth-user.js';
import { AppError } from '../common/errors/app-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { builtInLayout, completeLayout, layoutProblems, TABLES, type ColumnSetting } from './table-columns.js';

const ORG = 'ORG';

@Injectable()
export class TableLayoutsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private requireTable(table: string) {
    if (!Object.hasOwn(TABLES, table)) throw new NotFoundException('Unknown table.');
  }

  private assertValid(table: string, columns: ColumnSetting[]) {
    const problems = layoutProblems(table, columns);
    if (problems.length) throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_LAYOUT', 'This column layout does not fit this table any more. Reset the columns, then choose them again.', { problems });
  }

  /** The effective layout for the caller, where it comes from, and every column the table offers. */
  async effective(table: string, userId: string) {
    this.requireTable(table);
    const rows = await this.prisma.tableLayout.findMany({ where: { table, owner: { in: [userId, ORG] } }, select: { owner: true, columns: true } });
    const mine = rows.find((r) => r.owner === userId);
    const org = rows.find((r) => r.owner === ORG);
    const chosen = mine ?? org;
    return {
      table,
      columns: chosen ? completeLayout(table, chosen.columns as unknown as ColumnSetting[]) : builtInLayout(table),
      source: mine ? 'USER' as const : org ? 'ORG' as const : 'DEFAULT' as const,
      orgDefault: org ? completeLayout(table, org.columns as unknown as ColumnSetting[]) : builtInLayout(table),
      available: TABLES[table],
    };
  }

  /** The caller's own layout for a table. */
  async saveMine(table: string, columns: ColumnSetting[], caller: CallerCtx) {
    this.requireTable(table);
    this.assertValid(table, columns);
    await this.prisma.tableLayout.upsert({
      where: { owner_table: { owner: caller.id, table } },
      create: { owner: caller.id, table, columns: columns as never, updatedById: caller.id },
      update: { columns: columns as never, updatedById: caller.id },
    });
    return this.effective(table, caller.id);
  }

  /** Back to the organization default (removes the caller's own layout). */
  async resetMine(table: string, caller: CallerCtx) {
    this.requireTable(table);
    await this.prisma.tableLayout.deleteMany({ where: { owner: caller.id, table } });
    return this.effective(table, caller.id);
  }

  /** The organization default (Administrators, settings.manage). Audited. */
  async saveOrg(table: string, columns: ColumnSetting[], caller: CallerCtx) {
    this.requireTable(table);
    this.assertValid(table, columns);
    await this.prisma.$transaction(async (tx) => {
      await tx.tableLayout.upsert({
        where: { owner_table: { owner: ORG, table } },
        create: { owner: ORG, table, columns: columns as never, updatedById: caller.id },
        update: { columns: columns as never, updatedById: caller.id },
      });
      await this.audit.log({ actorId: caller.id, actorRole: caller.role, action: 'TABLE_LAYOUT_DEFAULT_SET', entity: 'TableLayout', entityId: table, metadata: { table, columns } }, tx);
    });
    return this.effective(table, caller.id);
  }

  /** Back to the built-in default for the organization. Audited. */
  async resetOrg(table: string, caller: CallerCtx) {
    this.requireTable(table);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.tableLayout.deleteMany({ where: { owner: ORG, table } });
      if (count) await this.audit.log({ actorId: caller.id, actorRole: caller.role, action: 'TABLE_LAYOUT_DEFAULT_RESET', entity: 'TableLayout', entityId: table, metadata: { table } }, tx);
    });
    return this.effective(table, caller.id);
  }
}
