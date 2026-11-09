/**
 * Storage verification (P0-05) — proves that the configured S3-compatible
 * bucket (production: Cloudflare R2) accepts an upload through the
 * application's own storage driver and returns exactly the same bytes.
 *
 * Used by `scripts/storage-verify.ts` (operator CLI) and by tests. It is not
 * imported by the running application.
 *
 * Safety rules enforced here:
 *   - It only ever writes, reads or deletes ONE object, under the dedicated
 *     prefix `p0-05-verification/<run id>/`; every key is checked against that
 *     shape before any write or delete (assertVerificationKey).
 *   - It never overwrites: the key must not exist before the upload.
 *   - Other objects are only LISTED (read-only), to prove afterwards that none
 *     was removed or changed. Their keys are never printed, only counts and a hash.
 *   - Deleting the test object happens only when the caller asks for it.
 */
import { NotFoundException } from '@nestjs/common';
import {
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { Readable } from 'stream';

import { MIME } from './file-rules.js';
import { S3StorageDriver, type S3DriverOptions } from './s3-storage.driver.js';
import type { StorageDriver } from './storage-driver.js';

export const VERIFICATION_PREFIX = 'p0-05-verification/';
const KEY_SHAPE = /^p0-05-verification\/\d{8}T\d{6}Z-[0-9a-f]{8}\/probe\.txt$/;

// ─────────────────────────────────────────────────────────────────────────────
// Bucket access used only for the checks the application driver does not offer
// ─────────────────────────────────────────────────────────────────────────────

export interface ObjectInfo { key: string; size: number; etag?: string }
export interface ObjectHead { size: number; contentType?: string; etag?: string }

/** Read-mostly view of the bucket. `delete` is only called for verified test keys. */
export interface ObjectStore {
  head(key: string): Promise<ObjectHead | null>;
  list(prefix?: string): Promise<ObjectInfo[]>;
  delete(key: string): Promise<void>;
}

/** S3 / R2 implementation, built from the same options as the application's driver. */
export class S3ObjectStore implements ObjectStore {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: Number(out.ContentLength ?? -1), contentType: out.ContentType, etag: out.ETag };
    } catch (err: any) {
      if (err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async list(prefix?: string): Promise<ObjectInfo[]> {
    const all: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const out = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of out.Contents ?? []) all.push({ key: o.Key!, size: Number(o.Size ?? -1), etag: o.ETag });
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return all;
  }

  async delete(key: string): Promise<void> {
    assertVerificationKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async headBucket(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }
}

/** The application's driver and a matching object store, from one set of options. */
export function createS3Targets(opts: S3DriverOptions): { driver: S3StorageDriver; store: S3ObjectStore } {
  const client = new S3Client({
    region:         opts.region ?? 'auto',
    endpoint:       opts.endpoint,
    forcePathStyle: opts.forcePathStyle,
    credentials:
      opts.accessKeyId && opts.secretAccessKey
        ? { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey }
        : undefined,
  });
  return { driver: new S3StorageDriver(opts), store: new S3ObjectStore(client, opts.bucket) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Keys
// ─────────────────────────────────────────────────────────────────────────────

/** A new run id: UTC timestamp + random suffix, e.g. 20261109T051500Z-1a2b3c4d. */
export function newRunId(now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `${ts}-${randomUUID().slice(0, 8)}`;
}

export function verificationKey(runId: string): string {
  const key = `${VERIFICATION_PREFIX}${runId}/probe.txt`;
  assertVerificationKey(key);
  return key;
}

/** Throws unless `key` is exactly a verification probe key. Guards every write and delete. */
export function assertVerificationKey(key: string): void {
  if (typeof key !== 'string' || !KEY_SHAPE.test(key)) {
    throw new Error('Refusing to touch an object outside p0-05-verification/<run id>/probe.txt.');
  }
}

/** Synthetic test content: a readable header plus random bytes (base64), no user data. */
export function makeProbePayload(runId: string, randomByteCount = 48 * 1024): Buffer {
  const header = `ROF LMS storage verification (P0-05)\nrun: ${runId}\nThis object contains only synthetic test data.\n\n`;
  return Buffer.concat([Buffer.from(header, 'utf8'), Buffer.from(randomBytes(randomByteCount).toString('base64'), 'utf8'), Buffer.from('\n')]);
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Hash of an inventory (sorted key|size|etag lines) — shows equality without printing keys. */
export function inventoryFingerprint(items: ObjectInfo[]): string {
  const lines = items.map((o) => `${o.key}|${o.size}|${o.etag ?? ''}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** Objects present before that are missing or changed afterwards. New objects are allowed (the app may be in use). */
export function compareInventories(before: ObjectInfo[], after: ObjectInfo[]) {
  const now = new Map(after.map((o) => [o.key, o]));
  let removed = 0, changed = 0;
  for (const o of before) {
    const a = now.get(o.key);
    if (!a) removed++;
    else if (a.size !== o.size || (a.etag ?? '') !== (o.etag ?? '')) changed++;
  }
  const beforeKeys = new Set(before.map((o) => o.key));
  return { removed, changed, added: after.filter((o) => !beforeKeys.has(o.key)).length };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────────────────────
// The verification
// ─────────────────────────────────────────────────────────────────────────────

export interface VerificationCheck { name: string; ok: boolean; detail?: string }
export interface VerificationReport {
  runId: string;
  key: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  ok: boolean;
  checks: VerificationCheck[];
  payload: { bytes: number; sha256: string; contentType: string };
  /** Whether the test object is still in the bucket at the end. */
  objectLeftInBucket: boolean;
}

export interface VerificationOptions {
  driver: StorageDriver;
  store: ObjectStore;
  runId?: string;
  payload?: Buffer;
  /** Delete the test object at the end (approval-gated in the CLI). */
  cleanup: boolean;
  /** List the rest of the bucket before and after (read-only) to prove nothing else changed. */
  inventory: boolean;
  log?: (line: string) => void;
}

export async function verifyStorage(opts: VerificationOptions): Promise<VerificationReport> {
  const runId = opts.runId ?? newRunId();
  const key = verificationKey(runId);
  const runPrefix = key.slice(0, key.lastIndexOf('/') + 1);
  const payload = opts.payload ?? makeProbePayload(runId);
  const contentType = MIME.TXT;
  const t0 = Date.now();
  const report: VerificationReport = {
    runId, key, startedAt: new Date(t0).toISOString(), ok: false, checks: [],
    payload: { bytes: payload.length, sha256: sha256(payload), contentType }, objectLeftInBucket: false,
  };
  const record = (name: string, ok: boolean, detail?: string) => {
    report.checks.push({ name, ok, detail });
    opts.log?.(`${ok ? '✔' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };
  const step = async (name: string, fn: () => Promise<string | undefined>) => {
    try { return record(name, true, await fn()); } catch (err) { return record(name, false, (err as Error).message.split('\n')[0].slice(0, 200)); }
  };

  let uploaded = false;
  let inventoried = false;
  let before: ObjectInfo[] = [];

  const checks = async () => {
    // 1. Same call as GET /health
    if (!await step('bucket reachable (driver ping, as /health)', async () => { await opts.driver.ping(); return `driver "${opts.driver.name}"`; })) return;

    // 2. Inventory of everything else (read-only)
    if (opts.inventory) {
      if (!await step('inventory before (read-only listing)', async () => {
        before = (await opts.store.list()).filter((o) => !o.key.startsWith(VERIFICATION_PREFIX));
        inventoried = true;
        return `${before.length} existing object(s), fingerprint ${inventoryFingerprint(before)}`;
      })) return;
    }

    // 3. Never overwrite
    if (!await step('test key is new (no overwrite)', async () => {
      if (await opts.store.head(key)) throw new Error('an object already exists at the test key');
      return undefined;
    })) return;

    // 4. Upload through the application's driver
    if (!await step('upload through the application storage driver', async () => {
      await opts.driver.put(key, payload, contentType);
      uploaded = true;
      return `${payload.length} bytes, ${contentType}`;
    })) return;

    // 5. Metadata as stored by the bucket
    await step('stored size, content type and ETag', async () => {
      const h = await opts.store.head(key);
      if (!h) throw new Error('object not found after upload');
      if (h.size !== payload.length) throw new Error(`size ${h.size}, expected ${payload.length}`);
      if (h.contentType !== contentType) throw new Error(`content type "${h.contentType}", expected "${contentType}"`);
      const etag = (h.etag ?? '').replace(/"/g, '');
      if (!etag) throw new Error('no ETag');
      // Single-part uploads: S3 and R2 use the MD5 of the content as ETag.
      if (/^[0-9a-f]{32}$/i.test(etag)) {
        const md5 = createHash('md5').update(payload).digest('hex');
        if (etag.toLowerCase() !== md5) throw new Error('ETag does not match the MD5 of the uploaded bytes');
        return `size ${h.size}, ${h.contentType}, ETag = MD5 of content`;
      }
      return `size ${h.size}, ${h.contentType}, ETag present (not an MD5)`;
    });

    // 6. Download through the application's driver: byte-identical
    await step('download through the application storage driver is byte-identical (SHA-256)', async () => {
      const got = await readAll(await opts.driver.getStream(key));
      const h = sha256(got);
      if (got.length !== payload.length || h !== report.payload.sha256) {
        throw new Error(`downloaded ${got.length} bytes, SHA-256 ${h.slice(0, 16)}… ≠ uploaded ${report.payload.sha256.slice(0, 16)}…`);
      }
      return `${got.length} bytes, SHA-256 ${h}`;
    });

    // 7. Exactly one object under this run's prefix
    await step('only the test object exists under its run prefix', async () => {
      const keys = (await opts.store.list(runPrefix)).map((o) => o.key);
      if (keys.length !== 1 || keys[0] !== key) throw new Error(`${keys.length} object(s) under the run prefix`);
      return undefined;
    });

    // 8. A missing object maps to "not found" (the API answers 404)
    await step('a missing object is reported as not found (API 404)', async () => {
      try {
        const s = await opts.driver.getStream(`${runPrefix}missing.txt`);
        s.destroy?.();
      } catch (err) {
        if (err instanceof NotFoundException) return undefined;
        throw new Error(`unexpected error: ${(err as Error).name}`);
      }
      throw new Error('a missing key returned a stream');
    });
  };

  try {
    await checks();
  } finally {
    // 9. Clean-up (only when asked), even if a check failed after the upload
    if (uploaded && opts.cleanup) {
      await step('test object deleted through the application driver, and gone', async () => {
        assertVerificationKey(key);
        await opts.driver.delete(key);
        if (await opts.store.head(key)) throw new Error('object still present after delete');
        return undefined;
      });
    }
    if (uploaded) {
      report.objectLeftInBucket = !!(await opts.store.head(key).catch(() => ({ size: -1 })));
    }

    // 10. Nothing else was removed or changed
    if (inventoried) {
      await step('existing objects unchanged (none removed or modified)', async () => {
        const after = (await opts.store.list()).filter((o) => !o.key.startsWith(VERIFICATION_PREFIX));
        const d = compareInventories(before, after);
        if (d.removed || d.changed) throw new Error(`${d.removed} removed, ${d.changed} changed`);
        return `${before.length} checked, 0 removed, 0 changed${d.added ? `, ${d.added} added by others during the run` : ''}`;
      });
    }
  }

  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - t0;
  report.ok = report.checks.length > 0 && report.checks.every((c) => c.ok);
  return report;
}

/** Delete a probe left by an earlier run (approval-gated in the CLI). Only probe keys are accepted. */
export async function deleteVerificationObject(driver: StorageDriver, store: ObjectStore, key: string): Promise<{ existed: boolean; gone: boolean }> {
  assertVerificationKey(key);
  const existed = !!(await store.head(key));
  if (existed) await driver.delete(key);
  return { existed, gone: !(await store.head(key)) };
}

/** Endpoint host for logs, with the account part masked (e.g. 1a2b….r2.cloudflarestorage.com). */
export function describeEndpoint(endpoint?: string): string {
  if (!endpoint) return 'AWS S3 (no endpoint)';
  try {
    const host = new URL(endpoint).host;
    const [first, ...rest] = host.split('.');
    return rest.length ? `${first.slice(0, 4)}….${rest.join('.')}` : host;
  } catch { return 'invalid endpoint'; }
}
