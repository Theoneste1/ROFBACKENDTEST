import { NotFoundException } from '@nestjs/common';
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { Readable } from 'stream';

import {
  S3ObjectStore,
  assertVerificationKey,
  compareInventories,
  deleteVerificationObject,
  describeEndpoint,
  makeProbePayload,
  newRunId,
  verificationKey,
  verifyStorage,
  type ObjectHead,
  type ObjectInfo,
  type ObjectStore,
} from './storage-verification.js';
import type { StorageDriver } from './storage-driver.js';
import { assertEnvFileIsPrivate, parseArgs, readS3Config } from '../../../scripts/storage-verify.js';

const RUN = '20261109T051500Z-1a2b3c4d';
const KEY = `p0-05-verification/${RUN}/probe.txt`;
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');

/** An in-memory bucket with the application-driver and object-store views over it. */
function fakeBucket(seed: Record<string, Buffer> = {}) {
  const objects = new Map<string, { data: Buffer; contentType: string }>(
    Object.entries(seed).map(([k, data]) => [k, { data, contentType: 'application/pdf' }]),
  );
  const driver = {
    name: 's3',
    ping: vi.fn(async () => {}),
    put: vi.fn(async (key: string, data: Buffer, contentType: string) => { objects.set(key, { data: Buffer.from(data), contentType }); }),
    getStream: vi.fn(async (key: string) => {
      const o = objects.get(key);
      if (!o) throw new NotFoundException('File not found.');
      return Readable.from([o.data]);
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  } satisfies StorageDriver & Record<string, unknown>;
  const store = {
    head: vi.fn(async (key: string): Promise<ObjectHead | null> => {
      const o = objects.get(key);
      return o ? { size: o.data.length, contentType: o.contentType, etag: `"${md5(o.data)}"` } : null;
    }),
    list: vi.fn(async (prefix = ''): Promise<ObjectInfo[]> =>
      [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, size: o.data.length, etag: `"${md5(o.data)}"` }))),
    delete: vi.fn(async (key: string) => { assertVerificationKey(key); objects.delete(key); }),
  } satisfies ObjectStore;
  return { objects, driver, store };
}

const USER_FILES = {
  'resources/2026/11/aaaaaaaa-0000-4000-8000-000000000001.pdf': Buffer.from('%PDF-1.4 user file one'),
  'submissions/2026/11/aaaaaaaa-0000-4000-8000-000000000002.pdf': Buffer.from('%PDF-1.4 user file two'),
};

describe('verification keys', () => {
  it('builds keys only under p0-05-verification/<run id>/probe.txt', () => {
    expect(verificationKey(RUN)).toBe(KEY);
    expect(newRunId(new Date('2026-11-09T05:15:00.123Z'))).toMatch(/^20261109T051500Z-[0-9a-f]{8}$/);
  });

  it.each([
    'resources/2026/11/aaaaaaaa-0000-4000-8000-000000000001.pdf',
    'p0-05-verification/',
    'p0-05-verification/anything/probe.txt',
    `p0-05-verification/${RUN}/other.txt`,
    `p0-05-verification/${RUN}/../../resources/x.pdf`,
    `/p0-05-verification/${RUN}/probe.txt`,
    `${KEY}x`,
    '',
  ])('refuses to touch %j', (key) => {
    expect(() => assertVerificationKey(key)).toThrow(/Refusing/);
  });

  it('the S3 object store refuses to delete anything but a probe key, before sending a request', async () => {
    const client = { send: vi.fn() };
    const store = new S3ObjectStore(client as any, 'rof-files');
    await expect(store.delete('resources/2026/11/a.pdf')).rejects.toThrow(/Refusing/);
    expect(client.send).not.toHaveBeenCalled();
  });

  it('deleteVerificationObject refuses other keys without calling the driver', async () => {
    const { driver, store } = fakeBucket(USER_FILES);
    await expect(deleteVerificationObject(driver, store, Object.keys(USER_FILES)[0])).rejects.toThrow(/Refusing/);
    expect(driver.delete).not.toHaveBeenCalled();
  });

  it('deleteVerificationObject removes a probe left by an earlier run', async () => {
    const { driver, store, objects } = fakeBucket({ [KEY]: Buffer.from('probe') });
    expect(await deleteVerificationObject(driver, store, KEY)).toEqual({ existed: true, gone: true });
    expect(objects.has(KEY)).toBe(false);
  });

  it('the payload is synthetic text', () => {
    const p = makeProbePayload(RUN, 1024).toString('utf8');
    expect(p).toContain('synthetic test data');
    expect(p).toContain(RUN);
  });
});

describe('verifyStorage', () => {
  it('passes end to end with clean-up: byte-identical, metadata right, user files untouched, nothing left', async () => {
    const { driver, store, objects } = fakeBucket(USER_FILES);
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: true });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      'bucket reachable (driver ping, as /health)',
      'inventory before (read-only listing)',
      'test key is new (no overwrite)',
      'upload through the application storage driver',
      'stored size, content type and ETag',
      'download through the application storage driver is byte-identical (SHA-256)',
      'only the test object exists under its run prefix',
      'a missing object is reported as not found (API 404)',
      'test object deleted through the application driver, and gone',
      'existing objects unchanged (none removed or modified)',
    ]);
    expect(r.objectLeftInBucket).toBe(false);
    expect(driver.put).toHaveBeenCalledWith(KEY, expect.any(Buffer), 'text/plain');
    expect([...objects.keys()].sort()).toEqual(Object.keys(USER_FILES).sort());
    for (const [k, data] of Object.entries(USER_FILES)) expect(objects.get(k)!.data.equals(data)).toBe(true);
    // Only the probe key was ever written or deleted.
    expect(driver.put.mock.calls.map((c) => c[0])).toEqual([KEY]);
    expect(driver.delete.mock.calls.map((c) => c[0])).toEqual([KEY]);
  });

  it('without clean-up the probe stays and is reported', async () => {
    const { driver, store, objects } = fakeBucket(USER_FILES);
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: false, inventory: true });
    expect(r.ok).toBe(true);
    expect(r.objectLeftInBucket).toBe(true);
    expect(objects.has(KEY)).toBe(true);
    expect(driver.delete).not.toHaveBeenCalled();
  });

  it('without inventory the rest of the bucket is not listed', async () => {
    const { driver, store } = fakeBucket(USER_FILES);
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: false });
    expect(r.ok).toBe(true);
    for (const call of store.list.mock.calls) expect(call[0]).toBe(`p0-05-verification/${RUN}/`);
  });

  it('detects a corrupted download and still cleans up', async () => {
    const { driver, store, objects } = fakeBucket();
    driver.getStream.mockImplementation(async (key: string) => {
      const o = objects.get(key);
      if (!o) throw new NotFoundException();
      const bad = Buffer.from(o.data); bad[0] ^= 0xff;
      return Readable.from([bad]);
    });
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: false });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith('download'))).toMatchObject({ ok: false });
    expect(objects.has(KEY)).toBe(false);
  });

  it('detects a wrong stored content type', async () => {
    const { driver, store } = fakeBucket();
    store.head.mockImplementation(async (key: string) => (key === KEY && driver.put.mock.calls.length ? { size: (driver.put.mock.calls[0][1] as Buffer).length, contentType: 'application/octet-stream', etag: '"x"' } : null));
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: false, inventory: false });
    expect(r.checks.find((c) => c.name.startsWith('stored size'))).toMatchObject({ ok: false, detail: expect.stringContaining('content type') });
    expect(r.ok).toBe(false);
  });

  it('detects an ETag that is not the MD5 of the uploaded bytes', async () => {
    const { driver, store } = fakeBucket();
    const realHead = store.head.getMockImplementation()!;
    store.head.mockImplementation(async (key: string) => {
      const h = await realHead(key);
      return h ? { ...h, etag: '"00000000000000000000000000000000"' } : null;
    });
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: false });
    expect(r.checks.find((c) => c.name.startsWith('stored size'))).toMatchObject({ ok: false, detail: expect.stringContaining('MD5') });
  });

  it.each([
    ['multipart-style', '"d41d8cd98f00b204e9800998ecf8427e-2"'],
    ['opaque', '"0x8DCB7A1E2F3"'],
  ])('fails on a %s ETag: a single-part upload must have the MD5 of its content as ETag', async (_kind, etag) => {
    const { driver, store } = fakeBucket();
    const realHead = store.head.getMockImplementation()!;
    store.head.mockImplementation(async (key: string) => {
      const h = await realHead(key);
      return h ? { ...h, etag } : null;
    });
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: false });
    expect(r.checks.find((c) => c.name.startsWith('stored size'))).toMatchObject({ ok: false, detail: expect.stringContaining('not an MD5') });
    expect(r.ok).toBe(false);
  });

  it('never overwrites: an existing object at the test key stops the run before any upload', async () => {
    const { driver, store, objects } = fakeBucket({ [KEY]: Buffer.from('already here') });
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: false });
    expect(r.ok).toBe(false);
    expect(driver.put).not.toHaveBeenCalled();
    expect(driver.delete).not.toHaveBeenCalled();
    expect(objects.get(KEY)!.data.toString()).toBe('already here');
  });

  it('stops at an unreachable bucket without writing anything', async () => {
    const { driver, store } = fakeBucket();
    driver.ping.mockRejectedValue(Object.assign(new Error('Forbidden'), { name: 'AccessDenied' }));
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: true });
    expect(r.ok).toBe(false);
    expect(r.checks).toHaveLength(1);
    expect(driver.put).not.toHaveBeenCalled();
    expect(store.list).not.toHaveBeenCalled();
  });

  it('fails if an existing object was removed or changed during the run; new objects are allowed', async () => {
    const { driver, store, objects } = fakeBucket(USER_FILES);
    const [first, second] = Object.keys(USER_FILES);
    driver.put.mockImplementation(async (key: string, data: Buffer, contentType: string) => {
      objects.set(key, { data, contentType });
      objects.delete(first);                                   // removed
      objects.set(second, { data: Buffer.from('changed'), contentType: 'application/pdf' }); // changed
    });
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: true });
    expect(r.checks.at(-1)).toMatchObject({ ok: false, detail: '1 removed, 1 changed' });

    expect(compareInventories(
      [{ key: 'a', size: 1, etag: 'x' }],
      [{ key: 'a', size: 1, etag: 'x' }, { key: 'b', size: 2 }],
    )).toEqual({ removed: 0, changed: 0, added: 1 });
  });

  describe('probes left by earlier runs are part of the integrity check', () => {
    const EARLIER = 'p0-05-verification/20261101T000000Z-aaaaaaaa/probe.txt';
    const seed = { ...USER_FILES, [EARLIER]: Buffer.from('probe from an earlier run') };

    it('are counted in the inventory and left untouched by a passing run', async () => {
      const { driver, store, objects } = fakeBucket(seed);
      const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: true });
      expect(r.ok).toBe(true);
      expect(r.checks.find((c) => c.name.startsWith('inventory before'))?.detail).toMatch(/^3 existing object\(s\) \(1 under p0-05-verification\/\)/);
      expect(r.checks.at(-1)?.detail).toMatch(/^3 checked, 0 removed, 0 changed$/);
      expect(objects.get(EARLIER)!.data.toString()).toBe('probe from an earlier run');
    });

    it('their removal during the run is detected', async () => {
      const { driver, store, objects } = fakeBucket(seed);
      driver.put.mockImplementation(async (key: string, data: Buffer, contentType: string) => {
        objects.set(key, { data, contentType });
        objects.delete(EARLIER);
      });
      const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: true });
      expect(r.ok).toBe(false);
      expect(r.checks.at(-1)).toMatchObject({ ok: false, detail: '1 removed, 0 changed' });
    });

    it('their modification during the run is detected', async () => {
      const { driver, store, objects } = fakeBucket(seed);
      driver.put.mockImplementation(async (key: string, data: Buffer, contentType: string) => {
        objects.set(key, { data, contentType });
        objects.set(EARLIER, { data: Buffer.from('overwritten'), contentType: 'text/plain' });
      });
      const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: true });
      expect(r.ok).toBe(false);
      expect(r.checks.at(-1)).toMatchObject({ ok: false, detail: '0 removed, 1 changed' });
    });

    it("only this run's own probe is excluded: keeping it (no clean-up) is not reported as added", async () => {
      const { driver, store } = fakeBucket(seed);
      const r = await verifyStorage({ driver, store, runId: RUN, cleanup: false, inventory: true });
      expect(r.ok).toBe(true);
      expect(r.checks.at(-1)?.detail).toBe('3 checked, 0 removed, 0 changed');
    });
  });

  it('a driver that does not map a missing object to "not found" fails that check', async () => {
    const { driver, store, objects } = fakeBucket();
    driver.getStream.mockImplementation(async (key: string) => {
      const o = objects.get(key);
      if (!o) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
      return Readable.from([o.data]);
    });
    const r = await verifyStorage({ driver, store, runId: RUN, cleanup: true, inventory: false });
    expect(r.checks.find((c) => c.name.startsWith('a missing object'))).toMatchObject({ ok: false });
  });
});

describe('describeEndpoint', () => {
  it('masks the account part of the host', () => {
    expect(describeEndpoint('https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com')).toBe('0123….r2.cloudflarestorage.com');
    expect(describeEndpoint(undefined)).toBe('AWS S3 (no endpoint)');
    expect(describeEndpoint('nope')).toBe('invalid endpoint');
  });
});

describe('storage-verify CLI', () => {
  const ENV = [
    'S3_BUCKET=rof-files',
    'S3_REGION=auto',
    'S3_ENDPOINT=https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    'S3_ACCESS_KEY_ID=AKIDEXAMPLEACCESSKEY',
    'S3_SECRET_ACCESS_KEY=example-secret-value-never-printed',
    'S3_FORCE_PATH_STYLE=true',
  ].join('\n');

  it('parses options; --env-file is required; --cleanup needs --execute', () => {
    expect(parseArgs(['--env-file', 'x'])).toMatchObject({ envFile: 'x', execute: false, cleanup: false, inventory: true });
    expect(parseArgs(['--env-file', 'x', '--execute', '--cleanup', '--no-inventory', '--confirm-bucket', 'b']))
      .toMatchObject({ execute: true, cleanup: true, inventory: false, confirmBucket: 'b' });
    expect(() => parseArgs([])).toThrow(/--env-file/);
    expect(() => parseArgs(['--env-file', 'x', '--cleanup'])).toThrow(/--execute/);
    expect(() => parseArgs(['--env-file', 'x', '--execute', '--delete-key', KEY])).toThrow(/either/);
    expect(() => parseArgs(['--env-file', 'x', '--bogus'])).toThrow(/unknown/);
    expect(() => parseArgs(['--env-file', '--execute'])).toThrow(/needs a value/);
  });

  it('reads the same S3_* settings as the API', () => {
    expect(readS3Config(ENV)).toEqual({
      bucket: 'rof-files', region: 'auto', endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      accessKeyId: 'AKIDEXAMPLEACCESSKEY', secretAccessKey: 'example-secret-value-never-printed', forcePathStyle: true,
    });
    expect(() => readS3Config('S3_BUCKET=rof-files\n')).toThrow(/S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
  });

  it('refuses an env file inside the repository that git would commit', () => {
    expect(() => assertEnvFileIsPrivate('package.json')).toThrow(/tracked by git/);
    expect(() => assertEnvFileIsPrivate('r2-settings.txt')).toThrow(/not git-ignored/);
    expect(() => assertEnvFileIsPrivate('.env.r2.local')).not.toThrow();       // covered by .env.*.local
    expect(() => assertEnvFileIsPrivate(join(tmpdir(), 'r2.env'))).not.toThrow(); // outside the repository
  });

  // Each case starts the script in a child process (tsx), ~2–3 s under a parallel test run.
  describe('runs (plan only, no network)', { timeout: 60_000 }, () => {
    const script = resolve('scripts/storage-verify.ts');
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { encoding: 'utf8', timeout: 60_000 });
    const envFile = join(mkdtempSync(join(tmpdir(), 'r2-verify-')), 'r2.env');
    writeFileSync(envFile, ENV);
    const noSecrets = (out: string) => {
      expect(out).not.toContain('example-secret-value-never-printed');
      expect(out).not.toContain('AKIDEXAMPLEACCESSKEY');
      expect(out).not.toContain('0123456789abcdef0123456789abcdef');
    };

    it('without --execute prints the plan and contacts nothing', () => {
      const r = run(['--env-file', envFile]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('PLAN ONLY');
      expect(r.stdout).toMatch(/p0-05-verification\/\d{8}T\d{6}Z-[0-9a-f]{8}\/probe\.txt/);
      expect(r.stdout).toContain('bucket "rof-files" at 0123….r2.cloudflarestorage.com');
      noSecrets(r.stdout + r.stderr);
    });

    it('--execute requires --confirm-bucket to repeat the bucket name', () => {
      expect(run(['--env-file', envFile, '--execute']).status).toBe(2);
      const wrong = run(['--env-file', envFile, '--execute', '--confirm-bucket', 'other-bucket']);
      expect(wrong.status).toBe(2);
      expect(wrong.stderr).toMatch(/--confirm-bucket/);
      noSecrets(wrong.stdout + wrong.stderr);
    });

    it('--delete-key refuses keys outside the verification prefix', () => {
      const r = run(['--env-file', envFile, '--delete-key', 'resources/2026/11/a.pdf', '--confirm-bucket', 'rof-files']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/Refusing/);
    });
  });
});
