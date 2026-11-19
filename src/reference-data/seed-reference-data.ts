import type { PrismaClient } from '../generated/prisma/client.js';
import { COUNTRIES } from './countries.data.js';

/**
 * The countries of migration 20261211000000, for databases whose rows were removed (the e2e suite truncates every table:
 * schools reference countries). Idempotent: existing rows are kept as they are.
 */
export async function seedReferenceData(db: Pick<PrismaClient, 'country'>): Promise<void> {
  await db.country.createMany({ data: COUNTRIES.map((c) => ({ ...c })), skipDuplicates: true });
}
