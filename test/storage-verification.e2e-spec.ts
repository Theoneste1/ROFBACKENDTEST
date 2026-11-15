/**
 * P0-05 storage verification (src/common/storage/storage-verification.ts and
 * scripts/storage-verify.ts) against a real S3 API endpoint.
 *
 * Needs an S3-compatible server; skipped otherwise:
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9000  S3_TEST_ACCESS_KEY=…  S3_TEST_SECRET_KEY=…
 * CI runs it against S3Mock. Passing here is NOT proof that Cloudflare R2 works —
 * that needs the approved live run (docs/operations/R2-VERIFICATION.md).
 */
import { CreateBucketCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  VERIFICATION_PREFIX,
  createS3Targets,
  deleteVerificationObject,
  verifyStorage,
} from '../src/common/storage/storage-verification.js';

const endpoint = process.env.S3_TEST_ENDPOINT;
const bucket = `rof-p0-05-${process.pid}`;

// In CI these tests must run, not be skipped: a green CI run then proves they passed on S3Mock.
if (process.env.CI && !endpoint) throw new Error('S3_TEST_ENDPOINT must be set in CI for the storage verification e2e tests.');

const EARLIER_PROBE = 'p0-05-verification/20261101T000000Z-aaaaaaaa/probe.txt';

describe.skipIf(!endpoint)('storage verification against an S3 API (e2e, needs S3_TEST_ENDPOINT)', () => {
  const opts = {
    bucket, region: 'us-east-1', endpoint, forcePathStyle: true,
    accessKeyId: process.env.S3_TEST_ACCESS_KEY, secretAccessKey: process.env.S3_TEST_SECRET_KEY,
  };
  let s3: S3Client;
  const userFiles: Record<string, string> = {
    'resources/2026/11/aaaaaaaa-0000-4000-8000-000000000001.pdf': '%PDF-1.4 existing user file one',
    'submissions/2026/11/aaaaaaaa-0000-4000-8000-000000000002.pdf': '%PDF-1.4 existing user file two',
    // A probe left by an earlier run: part of the integrity check, never touched.
    [EARLIER_PROBE]: 'probe from an earlier run',
  };
  const etags: Record<string, string | undefined> = {};
  const headEtag = (key: string) => s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then((h) => h.ETag, () => undefined);
  /** Probes other than the seeded earlier one. */
  const probes = async () => ((await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: VERIFICATION_PREFIX }))).Contents ?? [])
    .map((o) => o.Key).filter((k) => k !== EARLIER_PROBE);

  beforeAll(async () => {
    s3 = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: opts.accessKeyId!, secretAccessKey: opts.secretAccessKey! } });
    await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch((err) => {
      if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(String(err?.name))) throw err;
    });
    for (const [Key, body] of Object.entries(userFiles)) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key, Body: body, ContentType: 'application/pdf' }));
      etags[Key] = await headEtag(Key);
    }
  });

  const expectUserFilesUntouched = async () => {
    for (const key of Object.keys(userFiles)) expect(await headEtag(key)).toBe(etags[key]);
  };

  it('upload, metadata, byte-identical download, inventory and clean-up all pass through the application driver', async () => {
    const { driver, store } = createS3Targets(opts);
    const r = await verifyStorage({ driver, store, cleanup: true, inventory: true });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks).toHaveLength(10);
    expect(r.objectLeftInBucket).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith('inventory before'))?.detail).toMatch(/^3 existing object\(s\) \(1 under p0-05-verification\/\)/);
    expect(r.checks.find((c) => c.name.startsWith('stored size'))?.detail).toContain('ETag = MD5 of content');
    expect(r.checks.at(-1)?.detail).toBe('3 checked, 0 removed, 0 changed');
    expect(await probes()).toEqual([]);
    await expectUserFilesUntouched();
  });

  it('without clean-up the probe stays; deleteVerificationObject removes exactly that object later', async () => {
    const { driver, store } = createS3Targets(opts);
    const r = await verifyStorage({ driver, store, cleanup: false, inventory: true });
    expect(r.ok).toBe(true);
    expect(r.objectLeftInBucket).toBe(true);
    expect(await probes()).toEqual([r.key]);

    expect(await deleteVerificationObject(driver, store, r.key)).toEqual({ existed: true, gone: true });
    expect(await probes()).toEqual([]);
    await expect(deleteVerificationObject(driver, store, Object.keys(userFiles)[0])).rejects.toThrow(/Refusing/);
    await expectUserFilesUntouched();
  });

  it('the CLI runs the same verification from an env file, with clean-up, and prints no credentials', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'r2-verify-e2e-'));
    const envFile = join(dir, 'r2.env');
    const jsonFile = join(dir, 'report.json');
    writeFileSync(envFile, [
      `S3_BUCKET=${bucket}`, 'S3_REGION=us-east-1', `S3_ENDPOINT=${endpoint}`,
      `S3_ACCESS_KEY_ID=${opts.accessKeyId}`, `S3_SECRET_ACCESS_KEY=${opts.secretAccessKey}`, 'S3_FORCE_PATH_STYLE=true',
    ].join('\n'));
    const r = spawnSync(process.execPath, [
      '--import', 'tsx', resolve('scripts/storage-verify.ts'),
      '--env-file', envFile, '--execute', '--confirm-bucket', bucket, '--cleanup', '--json', jsonFile,
    ], { encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('10/10 checks passed');
    expect(r.stdout).toContain('No test object left in the bucket.');
    expect(r.stdout + r.stderr).not.toContain(opts.secretAccessKey!);
    const report = JSON.parse(readFileSync(jsonFile, 'utf8'));
    expect(report).toMatchObject({ ok: true, objectLeftInBucket: false, target: { bucket } });
    expect(JSON.stringify(report)).not.toContain(opts.secretAccessKey!);
    expect(await probes()).toEqual([]);
    await expectUserFilesUntouched();
  });
});
