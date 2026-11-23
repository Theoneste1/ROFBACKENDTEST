import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '../generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

import { readOnlyWhileViewing } from './read-only-while-viewing.js';

/** DATABASE_TX_MAX_WAIT_MS (default 10 000, at least 2 000, at most 20 000: below the ~26 s proxy limit). */
export function transactionMaxWaitMs(raw = process.env.DATABASE_TX_MAX_WAIT_MS): number {
  const n = Number(raw ?? 10_000);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 2_000), 20_000) : 10_000;
}

/** PRISMA_QUERY_EVENTS=true (tests only): per-statement 'query' events for query counting. */
export function queryEventsEnabled(raw = process.env.PRISMA_QUERY_EVENTS): boolean {
  return raw === 'true';
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Viewing requests ("view as", read only) can never write: src/prisma/read-only-while-viewing.ts.
    const adapter = readOnlyWhileViewing(new PrismaPg({
      connectionString: process.env.DATABASE_URL,
      // Default 10 for PostgreSQL. Set DATABASE_POOL_MAX=1 for the local
      // `prisma dev` server (PGlite), which cannot interleave connections.
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    }));

    // How long a transaction may wait for a pooled connection before it starts (Prisma's default is
    // 2 s). Long publications, rollovers and exports hold connections for tens of seconds at scale, so
    // short reads that use a batch transaction (list + count) must be able to queue for longer instead
    // of failing; a wait that still runs out answers 503 DATABASE_BUSY (all-exceptions.filter.ts).
    super({
      adapter, transactionOptions: { maxWait: transactionMaxWaitMs() },
      // Test-only instrumentation (PRISMA_QUERY_EVENTS=true, never set in deployments): emit a 'query' event per SQL
      // statement so the e2e suite can show a list reads a constant number of queries whatever its size (no N+1).
      ...(queryEventsEnabled() && { log: [{ emit: 'event' as const, level: 'query' as const }] }),
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
