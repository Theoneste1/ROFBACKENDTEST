/**
 * Upload rules per file purpose: allowed content types and size limits.
 *
 * Types are checked against the DETECTED type (magic bytes), never against
 * the Content-Type or extension the client sent.
 */
import { FilePurpose } from '../../generated/prisma/client.js';

export const MIME = {
  PDF:  'application/pdf',
  JPEG: 'image/jpeg',
  PNG:  'image/png',
  WEBP: 'image/webp',
  GIF:  'image/gif',
  HEIC: 'image/heic',
  HEIF: 'image/heif',
  DOCX: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  DOC:  'application/msword',
  PPTX: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  PPT:  'application/vnd.ms-powerpoint',
  ZIP:  'application/zip',
  EPUB: 'application/epub+zip',
  TXT:  'text/plain',
} as const;

const IMAGES = [MIME.JPEG, MIME.PNG, MIME.WEBP, MIME.GIF, MIME.HEIC, MIME.HEIF];

const MB = 1024 * 1024;

export interface FileRule {
  allowed: ReadonlySet<string>;
  maxBytes: number;
  /** Storage key prefix. */
  folder: string;
}

export const FILE_RULES: Record<FilePurpose, FileRule> = {
  SUBMISSION: {
    // Phone photos of handwritten solutions are common — HEIC included.
    allowed:  new Set([MIME.PDF, ...IMAGES, MIME.DOCX, MIME.DOC, MIME.ZIP, MIME.TXT]),
    maxBytes: 20 * MB,
    folder:   'submissions',
  },
  FEEDBACK: {
    allowed:  new Set([MIME.PDF, ...IMAGES, MIME.DOCX, MIME.DOC, MIME.TXT]),
    maxBytes: 10 * MB,
    folder:   'feedback',
  },
  ASSIGNMENT_BRIEF: {
    allowed:  new Set([MIME.PDF, ...IMAGES, MIME.DOCX, MIME.DOC, MIME.ZIP, MIME.TXT]),
    maxBytes: 20 * MB,
    folder:   'assignments',
  },
  RESOURCE: {
    allowed:  new Set([
      MIME.PDF, ...IMAGES, MIME.DOCX, MIME.DOC, MIME.PPTX, MIME.PPT,
      MIME.EPUB, MIME.ZIP, MIME.TXT,
    ]),
    maxBytes: 50 * MB,
    folder:   'resources',
  },
};

/** Types a browser may display inline. Everything else is forced to download. */
export const INLINE_TYPES: ReadonlySet<string> = new Set([
  MIME.PDF, MIME.JPEG, MIME.PNG, MIME.WEBP, MIME.GIF,
]);

/** Largest limit across purposes — used as the multer hard cap. */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(FILE_RULES).map((r) => r.maxBytes));
