import { NotFoundException } from '@nestjs/common';
import { createReadStream } from 'fs';
import { access, mkdir, rm, writeFile } from 'fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'path';
import type { Readable } from 'stream';

import type { StorageDriver } from './storage-driver.js';

/**
 * Stores files on the local filesystem under `root`.
 * Suitable for development and single-instance deployments.
 */
export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: 'wx' }); // never overwrite
  }

  async getStream(key: string): Promise<Readable> {
    const path = this.pathFor(key);
    try {
      await access(path);
    } catch {
      throw new NotFoundException('File not found.');
    }
    return createReadStream(path);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async ping(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root);
  }

  /**
   * Resolve a key to an absolute path, guaranteeing it stays inside `root`.
   * Uses path.relative so it works with both "/" and "\" separators.
   */
  private pathFor(key: string): string {
    const full = resolve(this.root, key);
    const rel  = relative(this.root, full);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new NotFoundException('File not found.');
    }
    return full;
  }
}
