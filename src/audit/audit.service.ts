import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any> | null;
}

type AuditWriter = Pick<Prisma.TransactionClient, 'auditLog'>;

/**
 * The audit trail: who did what to which record, and when.
 *
 * The table is append-only: a database trigger rejects every UPDATE and DELETE
 * (except clearing actorId when a user account is deleted — the actor's
 * username is kept in actorUsername, filled in by the database on insert).
 * There are no API routes that change audit records.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends a record to the audit log.
   *
   * - With `tx`: written inside the caller's transaction, so the audit row and
   *   the change commit (or roll back) together. Errors propagate.
   * - Without `tx`: written after the fact. A failure is logged but never
   *   turns an already-successful action into an error response.
   */
  async log(entry: AuditEntry, tx?: AuditWriter): Promise<void> {
    const data = toRow(entry);
    if (tx) {
      await tx.auditLog.create({ data });
      return;
    }
    try {
      await this.prisma.auditLog.create({ data });
    } catch (err) {
      this.logger.error(`Failed to write audit entry ${entry.action}: ${(err as Error).message}`);
    }
  }

  /** Appends many records in one statement (bulk operations such as imports). */
  async logMany(entries: AuditEntry[], tx?: AuditWriter): Promise<void> {
    if (entries.length === 0) return;
    const data = entries.map(toRow);
    if (tx) {
      await tx.auditLog.createMany({ data });
      return;
    }
    try {
      await this.prisma.auditLog.createMany({ data });
    } catch (err) {
      this.logger.error(`Failed to write ${entries.length} audit entries: ${(err as Error).message}`);
    }
  }
}

function toRow(entry: AuditEntry) {
  return {
    actorId:   entry.actorId   ?? null,
    actorRole: entry.actorRole ?? null,
    action:    entry.action,
    entity:    entry.entity,
    entityId:  entry.entityId  ?? null,
    metadata:  (entry.metadata as Prisma.InputJsonValue) ?? undefined,
  };
}
