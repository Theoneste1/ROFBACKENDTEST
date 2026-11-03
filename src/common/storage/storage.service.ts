/**
 * StorageService — the only way the application stores or serves files.
 *
 * Upload pipeline (store):
 *   1. Callers run authorization BEFORE calling store(); multer keeps the
 *      upload in memory, so a rejected request never touches storage.
 *   2. The real type is detected from the file's bytes and checked against
 *      the per-purpose allow-list and size limit (file-rules.ts).
 *   3. A random key is generated, bytes are written to the driver and a
 *      FileObject row records name, detected type, size and SHA-256.
 *
 * Download pipeline (send):
 *   Callers authorize first, then send() streams the bytes with a safe
 *   Content-Type, Content-Disposition and X-Content-Type-Options: nosniff.
 *
 * Orphaned FileObjects (e.g. a replaced resource file) are removed by a
 * nightly job.
 */
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash, randomUUID } from 'crypto';
import { extname } from 'path';
import { pipeline } from 'stream/promises';
import { fileTypeFromBuffer } from 'file-type';
import type { Response } from 'express';

import { PrismaService } from '../../prisma/prisma.service.js';
import { FilePurpose, type FileObject } from '../../generated/prisma/client.js';
import { AppError } from '../errors/app-error.js';
import { FILE_RULES, INLINE_TYPES, MIME } from './file-rules.js';
import { STORAGE_DRIVER, type StorageDriver } from './storage-driver.js';

/** Minimal shape needed to serve a file. */
export type ServableFile = Pick<FileObject, 'storageKey' | 'mimeType' | 'originalName' | 'size'>;

const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Store
  // ═══════════════════════════════════════════════════════════════════════════

  async store(
    file: Express.Multer.File,
    purpose: FilePurpose,
    uploadedById: string,
  ): Promise<FileObject> {
    const rule = FILE_RULES[purpose];
    const data = file.buffer;

    if (!data || data.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_FILE', 'The uploaded file is empty.');
    }
    if (data.length > rule.maxBytes) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'FILE_TOO_LARGE',
        `The file exceeds the ${Math.round(rule.maxBytes / (1024 * 1024))} MB limit.`,
      );
    }

    const detected = await this.detectType(data, file.originalname);
    if (!detected || !rule.allowed.has(detected.mime)) {
      throw new AppError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        'FILE_TYPE_NOT_ALLOWED',
        'This file type is not allowed here.',
        { detectedType: detected?.mime ?? 'unknown', allowed: [...rule.allowed] },
      );
    }

    const now = new Date();
    const key = [
      rule.folder,
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      `${randomUUID()}.${detected.ext}`,
    ].join('/');

    await this.driver.put(key, data, detected.mime);

    return this.prisma.fileObject.create({
      data: {
        storageKey:   key,
        purpose,
        originalName: sanitizeOriginalName(file.originalname, detected.ext),
        mimeType:     detected.mime,
        size:         data.length,
        sha256:       createHash('sha256').update(data).digest('hex'),
        uploadedById,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Serve
  // ═══════════════════════════════════════════════════════════════════════════

  /** Stream a file to the client. Authorization must already have happened. */
  async send(res: Response, file: ServableFile, opts: { download?: boolean } = {}) {
    const stream = await this.driver.getStream(file.storageKey);

    const inline = !opts.download && INLINE_TYPES.has(file.mimeType);
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', contentDisposition(file.originalName, inline));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    // Uploaded documents must never run script in our origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");

    try {
      await pipeline(stream, res);
    } catch (err) {
      // Client disconnects are normal; anything else is worth a log line.
      if ((err as NodeJS.ErrnoException)?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        this.logger.warn(`Streaming ${file.storageKey} failed: ${(err as Error).message}`);
      }
      if (!res.headersSent) res.status(500);
      res.destroy();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Maintenance
  // ═══════════════════════════════════════════════════════════════════════════

  async ping() {
    await this.driver.ping();
  }

  get driverName() {
    return this.driver.name;
  }

  /**
   * Nightly: delete files no record refers to any more (detached resource
   * files, uploads whose request failed after storing, …). Every reference to
   * a file goes through an attachment table, so a file is an orphan only when
   * no attachment of any kind points to it. Submission files stay attached to
   * their revision history and are never removed here.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'storage-orphan-cleanup' })
  async cleanupOrphans(): Promise<number> {
    if (this.config.get('WORKERS_ENABLED') === 'false') return 0;

    const orphans = await this.prisma.fileObject.findMany({
      where: {
        createdAt:             { lt: new Date(Date.now() - ORPHAN_GRACE_MS) },
        resourceAttachments:   { none: {} },
        assignmentAttachments: { none: {} },
        submissionAttachments: { none: {} },
        reviewAttachments:     { none: {} },
      },
      select: { id: true, storageKey: true },
      take:   500,
    });

    for (const f of orphans) {
      try {
        await this.driver.delete(f.storageKey);
        await this.prisma.fileObject.delete({ where: { id: f.id } });
      } catch (err) {
        this.logger.warn(`Could not remove orphan ${f.storageKey}: ${(err as Error).message}`);
      }
    }
    if (orphans.length) this.logger.log(`Removed ${orphans.length} orphaned file(s).`);
    return orphans.length;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private async detectType(data: Buffer, originalName: string): Promise<{ mime: string; ext: string } | null> {
    const ft = await fileTypeFromBuffer(data);
    if (ft) {
      // Legacy Office formats share one container type; trust the extension
      // only to choose between the two allowed legacy formats.
      if (ft.mime === 'application/x-cfb') {
        const ext = extname(originalName).toLowerCase();
        if (ext === '.doc') return { mime: MIME.DOC, ext: 'doc' };
        if (ext === '.ppt') return { mime: MIME.PPT, ext: 'ppt' };
        return null;
      }
      return { mime: ft.mime, ext: ft.ext };
    }
    return looksLikeText(data) ? { mime: MIME.TXT, ext: 'txt' } : null;
  }
}

/** UTF-8 text without NUL bytes. */
function looksLikeText(data: Buffer): boolean {
  const sample = data.subarray(0, 8192);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/** Keep the user's file name for display, without paths or control characters. */
export function sanitizeOriginalName(name: string, ext: string): string {
  const base = (name ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .trim()
    .slice(0, 200);
  return base || `file.${ext}`;
}

/** RFC 6266 / 5987 Content-Disposition with an ASCII fallback. */
export function contentDisposition(filename: string, inline: boolean): string {
  const type     = inline ? 'inline' : 'attachment';
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_');
  const encoded  = encodeURIComponent(filename);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
