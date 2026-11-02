import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  metadata?: Record<string, any> | null;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends a record to the audit log.
   * Fire-and-forget friendly — callers can await it or not.
   */
  async log(entry: AuditEntry): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorId:   entry.actorId   ?? null,
        actorRole: entry.actorRole ?? null,
        action:    entry.action,
        entity:    entry.entity,
        entityId:  entry.entityId  ?? null,
        // Prisma's Json type accepts any serialisable value
        metadata:  (entry.metadata as object) ?? undefined,
      },
    });
  }
}
