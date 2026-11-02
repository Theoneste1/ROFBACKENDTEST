import { NotFoundException } from '@nestjs/common';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Readable } from 'stream';
import { LocalStorageDriver } from './local-storage.driver.js';

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

describe('LocalStorageDriver', () => {
  let root: string;
  let driver: LocalStorageDriver;

  beforeEach(async () => {
    root   = await mkdtemp(join(tmpdir(), 'rof-storage-'));
    driver = new LocalStorageDriver(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is named "local"', () => {
    expect(driver.name).toBe('local');
  });

  it('writes nested keys and reads them back', async () => {
    await driver.put('submissions/2026/11/a.txt', Buffer.from('hello'));
    expect(await readFile(join(root, 'submissions', '2026', '11', 'a.txt'), 'utf8')).toBe('hello');
    expect(await readAll(await driver.getStream('submissions/2026/11/a.txt'))).toBe('hello');
  });

  it('refuses to overwrite an existing key', async () => {
    await driver.put('a.txt', Buffer.from('first'));
    await expect(driver.put('a.txt', Buffer.from('second'))).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('first');
  });

  it('returns 404 for a missing key', async () => {
    await expect(driver.getStream('missing.txt')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes a key, and deleting a missing key is a no-op', async () => {
    await driver.put('a.txt', Buffer.from('x'));
    await driver.delete('a.txt');
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
    await expect(driver.delete('a.txt')).resolves.toBeUndefined();
  });

  describe('path traversal', () => {
    it.each(['../../etc/passwd', '..\\..\\windows\\win.ini', 'a/../../outside.txt', '..'])(
      'rejects %j with 404',
      async (key) => {
        await expect(driver.getStream(key)).rejects.toBeInstanceOf(NotFoundException);
        await expect(driver.put(key, Buffer.from('x'))).rejects.toBeInstanceOf(NotFoundException);
        await expect(driver.delete(key)).rejects.toBeInstanceOf(NotFoundException);
      },
    );

    it('rejects an absolute path outside the root', async () => {
      const outside = join(tmpdir(), 'rof-outside.txt');
      await expect(driver.getStream(outside)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects the root itself', async () => {
      await expect(driver.getStream('')).rejects.toBeInstanceOf(NotFoundException);
      await expect(driver.getStream('.')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('allows keys that normalise to a path inside the root', async () => {
      await driver.put('a/../b.txt', Buffer.from('ok'));
      expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('ok');
    });
  });

  it('ping creates the root when missing', async () => {
    await rm(root, { recursive: true, force: true });
    await driver.ping();
    expect(existsSync(root)).toBe(true);
  });
});
