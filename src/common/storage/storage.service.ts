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
  type OnModuleInit,
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
import { OFFICE_TYPES, OneAtATime, libreOfficeConverter, parseRange, previewKey, type DocumentConverter } from './document-preview.js';
import { STORAGE_DRIVER, type StorageDriver } from './storage-driver.js';

/** Minimal shape needed to serve a file. */
export type ServableFile = Pick<FileObject, 'storageKey' | 'mimeType' | 'originalName' | 'size'>;

const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly conversions = new OneAtATime();
  /** The Word / PowerPoint → PDF converter (created when first needed; replaceable in tests). */
  converter?: DocumentConverter;

  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Say which storage is in use: /health reports "up" for both drivers, so
   * the log is where an operator confirms that uploads really go to the
   * bucket (and not to the server's own, possibly temporary, disk).
   */
  onModuleInit() {
    if (this.driver.name === 's3') {
      const endpoint = this.config.get<string>('S3_ENDPOINT');
      let host = 'AWS S3';
      try { if (endpoint) host = new URL(endpoint).host; } catch { host = 'invalid S3_ENDPOINT'; }
      this.logger.log(
        `File storage: S3-compatible bucket "${this.config.get<string>('S3_BUCKET')}" at ${host} ` +
        `(region ${this.config.get<string>('S3_REGION') || 'auto'}, path-style ${this.config.get('S3_FORCE_PATH_STYLE') ? 'on' : 'off'})`,
      );
    } else {
      this.logger.warn(
        'File storage: LOCAL disk. On hosts with temporary disks (Render, …) uploads are lost on every deploy — set STORAGE_DRIVER=s3.',
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Store
  // ═══════════════════════════════════════════════════════════════════════════

  async store(
    file: Express.Multer.File,
    purpose: FilePurpose,
    uploadedById: string | null,   // null: an applicant without an account yet (REG-02)
  ): Promise<FileObject> {
    const rule = FILE_RULES[purpose];
    const data = file.buffer;

    if (!data || data.length === 0) {
      throw new AppError(HttpStatus.BAD_REQUEST, 'EMPTY_FILE', 'The file is empty. Choose the file again (check that it opens on your device), then upload it.');
    }
    if (data.length > rule.maxBytes) {
      throw new AppError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'FILE_TOO_LARGE',
        `The file is larger than ${Math.round(rule.maxBytes / (1024 * 1024))} MB. Choose a smaller file (or a lower-resolution photo) and try again.`,
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

  /**
   * Stream a file to the client. Authorization must already have happened.
   * `cacheControl` overrides the default `private, no-store` (e.g. versioned profile pictures).
   */
  async send(
    res: Response, file: ServableFile,
    opts: { download?: boolean; cacheControl?: string; transform?: (data: Buffer) => Buffer | Promise<Buffer> } = {},
  ) {
    // ?preview=pdf on any file route (after its own authorization): a Word or PowerPoint file is answered as its PDF
    // preview, converted once and cached (owner 2026-11-27). Other files are sent as they are.
    if (res.req?.query?.preview === 'pdf' && OFFICE_TYPES.has(file.mimeType)) {
      file = await this.previewOf(file);
      opts = { ...opts, download: false };
    }
    // Range requests (a PDF viewer reading page by page): only for files sent as stored, never for transformed ones.
    const range = opts.transform ? null : parseRange(res.req?.headers?.range as string | undefined, file.size);
    if (range === 'UNSATISFIABLE') {
      res.status(416).setHeader('Content-Range', `bytes */${file.size}`);
      res.end();
      return;
    }
    const stream = await this.driver.getStream(file.storageKey, range ?? undefined);
    // `transform` (e.g. removing identifying metadata for a blind marker): the file is read whole (uploads are bounded)
    // and the transformed bytes are sent with their own length.
    let body: Buffer | null = null;
    if (opts.transform) {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
      body = await opts.transform(Buffer.concat(chunks));
    }

    const inline = !opts.download && INLINE_TYPES.has(file.mimeType);
    res.setHeader('Content-Type', file.mimeType);
    if (!opts.transform) res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.setHeader('Content-Length', String(body ? body.length : file.size));
    }
    res.setHeader('Content-Disposition', contentDisposition(file.originalName, inline));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', opts.cacheControl ?? 'private, no-store');
    // Uploaded documents must never run script in our origin.
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");

    if (body) {
      res.end(body);
      return;
    }
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

  /** Whether Word and PowerPoint previews are switched on (DOCUMENT_PREVIEW_ENABLED=true). */
  previewsEnabled(): boolean {
    return String(this.config.get('DOCUMENT_PREVIEW_ENABLED') ?? '').toLowerCase() === 'true';
  }

  /**
   * The PDF preview of a Word or PowerPoint file: the cached one, else converted now (one conversion at a time) and
   * cached. 409 PREVIEW_NOT_AVAILABLE while previews are switched off; 422 PREVIEW_FAILED when the file cannot be
   * converted (it can still be downloaded).
   */
  private async previewOf(file: ServableFile): Promise<ServableFile> {
    if (!this.previewsEnabled()) {
      throw new AppError(HttpStatus.CONFLICT, 'PREVIEW_NOT_AVAILABLE', 'This file cannot be shown here yet. Download it to open it.');
    }
    const key = previewKey(file.storageKey);
    const name = `${file.originalName.replace(/\.[^.]+$/, '')}.pdf`;
    const cached = await this.driver.size(key);
    if (cached !== null) return { storageKey: key, mimeType: MIME.PDF, originalName: name, size: cached };
    return this.conversions.run(async () => {
      const again = await this.driver.size(key);   // converted by an earlier caller while this one waited
      if (again !== null) return { storageKey: key, mimeType: MIME.PDF, originalName: name, size: again };
      const chunks: Buffer[] = [];
      for await (const c of await this.driver.getStream(file.storageKey)) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
      let pdf: Buffer;
      try {
        this.converter ??= libreOfficeConverter(this.config.get<string>('SOFFICE_PATH') || 'soffice');
        pdf = await this.converter(Buffer.concat(chunks), file.mimeType);
      } catch (e) {
        this.logger.warn(`Preview of ${file.storageKey} failed: ${(e as Error).message}`);
        throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'PREVIEW_FAILED', 'This file could not be shown here. Download it to open it.');
      }
      try {
        await this.driver.put(key, pdf, MIME.PDF);
      } catch (e) {
        if ((await this.driver.size(key)) === null) throw e;   // only "already there" is fine
      }
      return { storageKey: key, mimeType: MIME.PDF, originalName: name, size: pdf.length };
    });
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
   * a file goes through an attachment table (a test's paper or marking guide
   * included) or is an account's current profile picture, so a file is an orphan
   * only when nothing of either kind points to it. Submission files stay attached to
   * their revision history and are never removed here.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'storage-orphan-cleanup' })
  async scheduledCleanup(): Promise<number> {
    if (this.config.get('WORKERS_ENABLED') === 'false') return 0;
    return this.cleanupOrphans();
  }

  /** Delete up to 500 unreferenced files older than a day; returns how many. */
  async cleanupOrphans(): Promise<number> {
    const orphans = await this.prisma.fileObject.findMany({
      where: {
        createdAt:             { lt: new Date(Date.now() - ORPHAN_GRACE_MS) },
        resourceAttachments:   { none: {} },
        assignmentAttachments: { none: {} },
        submissionAttachments: { none: {} },
        reviewAttachments:     { none: {} },
        avatarOf:              { is: null },
        teacherApplicationAvatarOf: { is: null },
        mentorRequestAvatarOf:      { is: null },
        testFiles:                  { none: {} },   // a test's paper or marking guide (Test Management)
        testAnswerPage:             { is: null },   // a page of a test answer, pending or submitted (Test Management)
      },
      select: { id: true, storageKey: true },
      take:   500,
    });

    for (const f of orphans) {
      try {
        await this.driver.delete(f.storageKey);
        await this.driver.delete(previewKey(f.storageKey)).catch(() => undefined);   // its cached preview, if any
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
