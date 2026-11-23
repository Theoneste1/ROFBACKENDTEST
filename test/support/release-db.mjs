// Disposable databases for the release-kit tests (test/release-rollback-resume.e2e-spec.ts and scripts/release tests):
// created next to TEST_DATABASE_URL under a random rk_* name, migrated one migration at a time, cloned from a template,
// and dropped afterwards. Never touches the schema or data of the shared test database.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/** Prisma's history table, exactly as `prisma migrate deploy` creates it. */
const HISTORY_DDL = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" VARCHAR(36) PRIMARY KEY NOT NULL,
  "checksum" VARCHAR(64) NOT NULL,
  "finished_at" TIMESTAMPTZ,
  "migration_name" VARCHAR(255) NOT NULL,
  "logs" TEXT,
  "rolled_back_at" TIMESTAMPTZ,
  "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
)`;

/** The URL of database `name` on the server of `baseUrl` (same user and options). */
export function databaseUrl(baseUrl, name) {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  u.searchParams.delete('application_name');
  return u.toString();
}

export const randomName = (prefix) => `rk_${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

export async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** CREATE DATABASE (optionally from a template, which must have no open connection). Names must be rk_*. */
export async function createDatabase(adminUrl, name, template) {
  if (!/^rk_[a-z0-9_]+$/.test(name) || (template && !/^rk_[a-z0-9_]+$/.test(template))) throw new Error(`refused database name ${name}`);
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE "${name}"${template ? ` TEMPLATE "${template}"` : ''}`));
}

export async function dropDatabase(adminUrl, name) {
  if (!/^rk_[a-z0-9_]+$/.test(name)) throw new Error(`refused database name ${name}`);
  await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
}

/** Applies one migration as `prisma migrate deploy` does (its SQL as one script, then its history row). */
export async function applyMigration(client, root, name) {
  await client.query(HISTORY_DDL);
  const sql = readFileSync(join(root, 'prisma/migrations', name, 'migration.sql'), 'utf8');
  await client.query(sql);
  await client.query(
    `INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "started_at", "applied_steps_count")
     VALUES ($1, $2, now(), $3, now(), 1)`, [randomUUID(), createHash('sha256').update(sql).digest('hex'), name]);
}
