// The Phase 1 migrations (M1–M14), shared by the rehearsal runner and the drill verifier.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Phase 1 migration names: 20261121000000_… to 20261121001300_… (M1–M14). */
export const PHASE1 = /^2026112100[01]\d00_/;
export const PHASE1_COUNT = 14;
/** The timestamp of M14, the last Phase 1 migration. */
export const LAST_PHASE1_TIMESTAMP = '20261121001300';

/**
 * Migration names that sort AFTER M14 (Prisma applies migrations in name order). The kit rehearses and
 * rolls back exactly the 14 Phase 1 migrations, so any later migration — in the checkout or already
 * recorded in a database — means this is not the Phase 1 state the kit was built for (owner decision
 * 2026-11-13: refuse rather than deploy or roll back more, or less, than Phase 1).
 * @param {string[]} names migration directory names, or migration_name values from _prisma_migrations
 */
export function laterMigrations(names) {
  // By timestamp alone: e.g. a `20261121001400_…` would also match the PHASE1 pattern but comes after M14.
  return names.filter((n) => n.slice(0, LAST_PHASE1_TIMESTAMP.length) > LAST_PHASE1_TIMESTAMP).sort();
}

/**
 * What a database looks like BEFORE the Phase 1 migrations (production `main` today), derived from this
 * checkout alone — no other branch or checkout is read: the repository migrations without M1–M14, and
 * the Prisma models without the tables M1–M14 create. Phase 1 creates tables and never drops or
 * renames one, so the subtraction is exact (checked by the tests).
 * @param {{ migDirs: string[], models: string[], phase1Sql: string[] }} input
 */
export function prePhase1Baseline({ migDirs, models, phase1Sql }) {
  const phase1Dirs = migDirs.filter((d) => PHASE1.test(d));
  if (phase1Dirs.length !== PHASE1_COUNT) throw new Error(`expected ${PHASE1_COUNT} Phase 1 migrations, found ${phase1Dirs.length}`);
  const created = new Set(phase1Sql.flatMap((sql) => [...sql.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])));
  return { migrations: migDirs.filter((d) => !PHASE1.test(d)), models: models.filter((m) => !created.has(m)) };
}

/** Reads the inputs of prePhase1Baseline from a checkout (`root` = the repository root). */
export function readPhase1Sql(root, migDirs) {
  return migDirs.filter((d) => PHASE1.test(d)).map((d) => readFileSync(join(root, 'prisma/migrations', d, 'migration.sql'), 'utf8'));
}

export const migrationDirs = (root) =>
  readdirSync(join(root, 'prisma/migrations'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
