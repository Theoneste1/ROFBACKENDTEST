/**
 * Shared helpers for multi-file attachments (resources, assignment briefs,
 * submissions, mentor reviews).
 *
 * Upload endpoints accept the files in `files` (up to 10) and, for backward
 * compatibility, a single file in `file`.
 */
import { HttpStatus } from '@nestjs/common';
import { AppError } from '../errors/app-error.js';

export const MAX_ATTACHMENTS = 10;

/** Multer field configuration for FileFieldsInterceptor. */
export const ATTACHMENT_FIELDS = [
  { name: 'file',  maxCount: 1 },
  { name: 'files', maxCount: MAX_ATTACHMENTS },
];

export interface UploadedAttachmentFiles {
  file?:  Express.Multer.File[];
  files?: Express.Multer.File[];
}

/** Flatten both upload fields into one list (order preserved). */
export function filesFrom(upload?: UploadedAttachmentFiles): Express.Multer.File[] {
  const all = [...(upload?.file ?? []), ...(upload?.files ?? [])];
  if (all.length > MAX_ATTACHMENTS) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'TOO_MANY_FILES', `At most ${MAX_ATTACHMENTS} files per upload.`);
  }
  return all;
}

/** Public shape of an attachment in API responses. */
export const ATTACHMENT_SELECT = {
  id:        true,
  sortOrder: true,
  file:      { select: { id: true, originalName: true, mimeType: true, size: true } },
} as const;
