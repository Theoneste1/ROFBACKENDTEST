/**
 * Synthetic accounts for the staging application test (STAGING-AND-RESTORE.md §3), on the Neon BRANCH only.
 *
 * The branch is a copy of production and holds real people's data (minors). The staging test never signs in as a real
 * user: it uses two synthetic accounts that this script creates in the branch:
 *   - an Administrator   staging.drill.admin-<run>    (e-mail on the reserved .invalid domain: nothing is ever sent)
 *   - a student          staging.drill.student-<run>  without a date of birth (exercises the first-sign-in step)
 * Signing in on the staging site with them also PROVES ISOLATION: the accounts exist only in the branch, so the staging
 * backend can sign them in only if it really reads the branch (never production).
 *
 *   node scripts/release/staging-accounts.mjs create  --confirm <ep-id>   (WRITES to the branch)
 *   node scripts/release/staging-accounts.mjs disable --confirm <ep-id>   (WRITES: removes their passwords, deactivates)
 *
 * Target: the same fail-closed guard as the release kit (DRILL_DATABASE_URL in `.env.drill.local`, the production host
 * known from `.env.production.local` and refused, --confirm = the branch endpoint id). Passwords are random, written
 * only to `.env.staging-accounts.local` (git-ignored) and never printed. Deleting the branch after the drill removes
 * the accounts with everything else.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { resolveDrillTarget, readTargetInputs } from '../db-drill-verify.mjs';
import { endpointId } from './rehearsal.mjs';

export const PREFIX = 'staging.drill.';
export const ACCOUNTS_FILE = '.env.staging-accounts.local';
const BCRYPT_COST = 12;

/** The two synthetic accounts of one run (pure). Never a real-looking address: `.invalid` is reserved (RFC 2606). */
export function plan(run, divisionId) {
  const base = { lastName: 'Drill', isApproved: true, isActive: true, accountStatus: 'ACTIVE' };
  return [
    { ...base, key: 'ADMIN', role: 'ADMIN', firstName: 'Staging Admin', username: `${PREFIX}admin-${run}`, email: `${PREFIX}admin-${run}@staging.invalid`, gradeLevel: null, divisionId: null },
    { ...base, key: 'STUDENT', role: 'STUDENT', firstName: 'Staging Student', username: `${PREFIX}student-${run}`, email: `${PREFIX}student-${run}@staging.invalid`, gradeLevel: 'S2', divisionId },
  ];
}

/** Writes and confirm checks shared by the commands (pure). */
export function checkRequest(command, args, target) {
  if (!['create', 'disable'].includes(command)) return { ok: false, code: 2, reason: 'usage: node scripts/release/staging-accounts.mjs <create|disable> --confirm <ep-id>' };
  if (!target.ok) return { ok: false, code: target.code, reason: target.reason };
  const confirm = args.includes('--confirm') ? String(args[args.indexOf('--confirm') + 1] ?? '').toLowerCase() : '';
  if (confirm !== endpointId(target.url)) return { ok: false, code: 3, reason: 'refused: --confirm must be the staging branch endpoint id (ep-…) shown in the Neon console.' };
  return { ok: true };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const target = resolveDrillTarget(readTargetInputs());
  const check = checkRequest(command, args, target);
  if (!check.ok) { console.error(`✗ ${check.reason}`); return check.code; }
  const client = new pg.Client({ connectionString: target.url });
  await client.connect();
  try {
    if (command === 'disable') {
      const r = await client.query(
        `UPDATE "User" SET "passwordHash" = NULL, "isActive" = false, "accountStatus" = 'DEACTIVATED', "updatedAt" = now()
         WHERE "username" LIKE $1 AND "email" LIKE '%@staging.invalid'`, [`${PREFIX}%`]);
      console.log(`✓ ${r.rowCount} synthetic account(s) disabled on endpoint ${endpointId(target.url)}`);
      return 0;
    }
    if (existsSync(ACCOUNTS_FILE)) { console.error(`✗ refused: ${ACCOUNTS_FILE} exists (accounts already created); run disable first or remove the file.`); return 4; }
    const division = await client.query(`SELECT "id" FROM "Division" WHERE "isActive" ORDER BY "code" LIMIT 1`);
    if (!division.rows[0]) { console.error('✗ no active division in the branch'); return 4; }
    const run = randomBytes(3).toString('hex');
    const lines = [`# Synthetic staging accounts on endpoint ${endpointId(target.url)} — never commit, delete after the drill`];
    await client.query('BEGIN');
    for (const a of plan(run, division.rows[0].id)) {
      const password = `${randomBytes(15).toString('base64url')}-Aa1!`;
      await client.query(
        `INSERT INTO "User" ("id","firstName","lastName","username","email","passwordHash","role","isApproved","isActive","accountStatus","activatedAt","gradeLevel","divisionId","createdAt","updatedAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7::"Role",$8,$9,$10::"AccountStatus",now(),$11::"GradeLevel",$12,now(),now())`,
        [randomUUID(), a.firstName, a.lastName, a.username, a.email, await bcrypt.hash(password, BCRYPT_COST), a.role, a.isApproved, a.isActive, a.accountStatus, a.gradeLevel, a.divisionId]);
      lines.push(`STAGING_${a.key}_USERNAME=${a.username}`, `STAGING_${a.key}_PASSWORD=${password}`);
    }
    await client.query('COMMIT');
    writeFileSync(ACCOUNTS_FILE, lines.join('\n') + '\n', { mode: 0o600 });
    console.log(`✓ 2 synthetic accounts created on endpoint ${endpointId(target.url)} (${PREFIX}admin-${run}, ${PREFIX}student-${run}); passwords in ${ACCOUNTS_FILE}`);
    return 0;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`✗ ${e.message}`); process.exitCode = 1; });
}
