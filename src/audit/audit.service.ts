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
    const data = {
      actorId:   entry.actorId   ?? null,
      actorRole: entry.actorRole ?? null,
      action:    entry.action,
      entity:    entry.entity,
      entityId:  entry.entityId  ?? null,
      metadata:  (entry.metadata as Prisma.InputJsonValue) ?? undefined,
    };

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
}
