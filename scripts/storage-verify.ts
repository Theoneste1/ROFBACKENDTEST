/**
 * P0-05 — verify the file storage bucket (production: Cloudflare R2) through
 * the application's own S3 storage driver.
 *
 *   npm run storage:verify -- --env-file .env.r2.local                       # PLAN ONLY: no network
 *   npm run storage:verify -- --env-file .env.r2.local --execute \
 *        --confirm-bucket rof-files [--cleanup] [--no-inventory] [--json <file>]
 *   npm run storage:verify -- --env-file .env.r2.local --delete-key <key> --confirm-bucket rof-files
 *
 * The env file holds the same S3_* settings as the API (Render):
 *   S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE
 * It must be git-ignored (e.g. `.env.r2.local`, covered by `.env.*.local`) or outside the repository.
 * Only that file is read — not `.env` and not the process environment.
 *
 * What it does with --execute (see docs/operations/R2-VERIFICATION.md):
 *   writes ONE synthetic object under p0-05-verification/<run id>/probe.txt, checks its
 *   size, content type, ETag and SHA-256 after download, lists the rest of the bucket
 *   before and after (read-only) to prove nothing else changed, and deletes the object
 *   only with --cleanup. Never prints credentials or the keys of other objects.
 *
 * Exit codes: 0 passed (or plan printed) · 1 a check failed · 2 bad arguments or configuration.
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { isAbsolute, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { parse } from 'dotenv';

import {
  createS3Targets,
  deleteVerificationObject,
  describeEndpoint,
  newRunId,
  verificationKey,
  verifyStorage,
  VERIFICATION_PREFIX,
} from '../src/common/storage/storage-verification.js';
import type { S3DriverOptions } from '../src/common/storage/s3-storage.driver.js';

export interface CliArgs {
  envFile?: string;
  execute: boolean;
  cleanup: boolean;
  inventory: boolean;
  confirmBucket?: string;
  deleteKey?: string;
  json?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, cleanup: false, inventory: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--env-file') args.envFile = value();
    else if (a === '--execute') args.execute = true;
    else if (a === '--cleanup') args.cleanup = true;
    else if (a === '--no-inventory') args.inventory = false;
    else if (a === '--confirm-bucket') args.confirmBucket = value();
    else if (a === '--delete-key') args.deleteKey = value();
    else if (a === '--json') args.json = value();
    else throw new Error(`unknown option ${a}`);
  }
  if (!args.envFile) throw new Error('--env-file <file> is required (e.g. .env.r2.local)');
  if (args.cleanup && !args.execute) throw new Error('--cleanup only makes sense with --execute');
  if (args.deleteKey && args.execute) throw new Error('use either --execute or --delete-key, not both');
  return args;
}

/** S3 driver options from the env-file text (same variable names as the API). */
export function readS3Config(text: string): S3DriverOptions {
  const env = parse(text);
  const missing = ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((k) => !env[k]?.trim());
  if (missing.length) throw new Error(`missing in the env file: ${missing.join(', ')}`);
  const force = (env.S3_FORCE_PATH_STYLE ?? '').trim().toLowerCase();
  return {
    bucket:          env.S3_BUCKET.trim(),
    region:          env.S3_REGION?.trim() || 'auto',
    endpoint:        env.S3_ENDPOINT.trim(),
    accessKeyId:     env.S3_ACCESS_KEY_ID.trim(),
    secretAccessKey: env.S3_SECRET_ACCESS_KEY.trim(),
    forcePathStyle:  force === 'true' || force === '1',
  };
}

/** The env file must not be committable: outside the repository, or git-ignored and untracked. */
export function assertEnvFileIsPrivate(file: string, repoRoot = process.cwd()): void {
  const rel = relative(repoRoot, resolve(file));
  if (rel.startsWith('..') || isAbsolute(rel)) return; // outside the repository
  const git = (...a: string[]) => spawnSync('git', a, { cwd: repoRoot, encoding: 'utf8' });
  if (git('ls-files', '--error-unmatch', '--', rel).status === 0) throw new Error(`${rel} is tracked by git — credentials must never be committed`);
  const ignored = git('check-ignore', '-q', '--', rel);
  if (ignored.status !== 0) throw new Error(`${rel} is not git-ignored — use a name like .env.r2.local`);
}

function describeTarget(cfg: S3DriverOptions): string {
  return `bucket "${cfg.bucket}" at ${describeEndpoint(cfg.endpoint)} (region ${cfg.region}, path-style ${cfg.forcePathStyle ? 'on' : 'off'}); credentials loaded (not shown)`;
}

async function main(argv: string[]): Promise<number> {
  let args: CliArgs, cfg: S3DriverOptions;
  try {
    args = parseArgs(argv);
    if (!existsSync(args.envFile!)) throw new Error(`env file not found: ${args.envFile}`);
    assertEnvFileIsPrivate(args.envFile!);
    cfg = readS3Config(readFileSync(args.envFile!, 'utf8'));
    if ((args.execute || args.deleteKey) && args.confirmBucket !== cfg.bucket) {
      throw new Error('--confirm-bucket must repeat the bucket name from the env file before anything touches the bucket');
    }
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 2;
  }

  console.log(`Target: ${describeTarget(cfg)}`);

  if (args.deleteKey) {
    const { driver, store } = createS3Targets(cfg);
    try {
      const r = await deleteVerificationObject(driver, store, args.deleteKey);
      console.log(`${r.gone ? '✔' : '✗'} ${args.deleteKey}: ${r.existed ? 'deleted' : 'was not present'}${r.gone ? '' : ' — STILL PRESENT'}`);
      return r.gone ? 0 : 1;
    } catch (err) {
      console.error(`✗ ${(err as Error).message.split('\n')[0]}`);
      return /outside p0-05-verification/.test((err as Error).message) ? 2 : 1;
    }
  }

  const runId = newRunId();
  if (!args.execute) {
    console.log([
      'PLAN ONLY — nothing was sent to the bucket. Add --execute --confirm-bucket <bucket> to run.',
      `  1. HeadBucket (same call as /health)`,
      args.inventory ? `  2. list all objects (read-only) — counts and a hash only, no keys printed` : `  2. (inventory skipped)`,
      `  3. confirm ${verificationKey(runId)} does not exist (keys are new for every run)`,
      `  4. upload ~64 KiB of synthetic text through the application's S3 driver (text/plain)`,
      `  5. HEAD: size, content type, ETag (= MD5 for single-part uploads)`,
      `  6. download through the application's driver; compare SHA-256`,
      `  7. list ${VERIFICATION_PREFIX}<run id>/ — exactly one object`,
      `  8. read a missing key — expect "not found" (API 404)`,
      args.cleanup ? `  9. delete the test object through the driver; HEAD must return 404` : `  9. leave the test object in place (re-run with --cleanup, or --delete-key later)`,
      args.inventory ? ` 10. list again — every existing object present and unchanged` : ` 10. (inventory skipped)`,
    ].join('\n'));
    return 0;
  }

  const { driver, store } = createS3Targets(cfg);
  const report = await verifyStorage({ driver, store, runId, cleanup: args.cleanup, inventory: args.inventory, log: (l) => console.log(l) });
  const passed = report.checks.filter((c) => c.ok).length;
  console.log(`\n${passed}/${report.checks.length} checks passed in ${report.durationMs} ms — ${report.ok ? 'PASSED' : 'FAILED'}`);
  console.log(report.objectLeftInBucket
    ? `Test object left in the bucket: ${report.key}\n  remove later with: --delete-key ${report.key} --confirm-bucket ${cfg.bucket}`
    : 'No test object left in the bucket.');
  if (args.json) {
    writeFileSync(args.json, JSON.stringify({ target: { bucket: cfg.bucket, endpoint: describeEndpoint(cfg.endpoint), region: cfg.region, forcePathStyle: cfg.forcePathStyle }, ...report }, null, 2) + '\n');
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`✗ ${(err as Error).message?.split('\n')[0]}`);
    process.exit(1);
  });
}
