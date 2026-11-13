// The Phase 1 migrations (M1–M14), shared by the rehearsal runner and the drill verifier.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Phase 1 migration names: 20261121000000_… to 20261121001300_… (M1–M14). */
export const PHASE1 = /^2026112100[01]\d00_/;
export const PHASE1_COUNT = 14;

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
