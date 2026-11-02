/**
 * file.utils.ts — Central file-serving security utilities
 *
 * All download/serve handlers in the application must use these helpers.
 * They prevent:
 *   - Path traversal: resolving paths outside the intended subdirectory
 *   - Unguessable-URL reliance: file serving goes through authenticated
 *     controller endpoints only (ServeStatic is disabled)
 *   - Direct filename injection: stored filenames are validated to be
 *     UUID-based (no directory separators, no "..")
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { existsSync } from 'fs';
import { join, resolve, basename } from 'path';

/** Root directory for all uploads. All subdirectories live here. */
const UPLOADS_ROOT = join(process.cwd(), 'uploads');

/**
 * Allowed upload subdirectories.
 * Every file served by the application must be under one of these.
 */
export const UPLOAD_DIRS = {
  assignments: join(UPLOADS_ROOT, 'assignments'),
  submissions: join(UPLOADS_ROOT, 'submissions'),
  feedback:    join(UPLOADS_ROOT, 'feedback'),
  resources:   join(UPLOADS_ROOT, 'resources'),
} as const;

export type UploadSubdir = keyof typeof UPLOAD_DIRS;

/**
 * Resolves a stored `fileUrl` to an absolute path within the specified
 * subdirectory, with full path-containment validation.
 *
 * @param fileUrl  The value stored in the database (e.g. `/uploads/assignments/<uuid>.pdf`)
 * @param subdir   The expected subdirectory key (e.g. `"assignments"`)
 * @returns        Absolute path safe to pass to `fs.createReadStream` or `res.download`
 * @throws `BadRequestException` if the filename is invalid
 * @throws `NotFoundException`   if the file does not exist on disk
 */
export function resolveUploadPath(fileUrl: string, subdir: UploadSubdir): string {
  // 1. Extract just the filename — never use any directory component from fileUrl.
  const storedName = basename(fileUrl);

  // 2. Reject obviously unsafe names.
  if (!storedName || storedName.includes('..') || storedName.includes('/') || storedName.includes('\\')) {
    throw new BadRequestException('Invalid file reference.');
  }

  // 3. Construct the expected absolute path.
  const expectedDir    = UPLOAD_DIRS[subdir];
  const absolutePath   = join(expectedDir, storedName);
  const resolvedPath   = resolve(absolutePath);

  // 4. Path containment check — the resolved path must start with the
  //    expected directory. This blocks any remaining traversal attempts.
  if (!resolvedPath.startsWith(resolve(expectedDir) + '/') &&
      resolvedPath !== resolve(expectedDir)) {
    throw new BadRequestException('Invalid file reference.');
  }

  // 5. Verify the file actually exists.
  if (!existsSync(resolvedPath)) {
    throw new NotFoundException('File not found.');
  }

  return resolvedPath;
}

/**
 * MIME types that browsers can render inline without downloading.
 * Everything else is served as `attachment` (forced download).
 * This list is deliberately conservative.
 */
const INLINE_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'text/plain',
]);

/**
 * Build the correct Content-Disposition value for a file.
 *
 * @param mimeType         The file's MIME type (from the database record)
 * @param displayFilename  The original filename to show the user
 * @param forceDownload    If true, always use `attachment`
 */
export function contentDisposition(
  mimeType:        string | null | undefined,
  displayFilename: string | null | undefined,
  forceDownload = false,
): string {
  const mime = mimeType ?? 'application/octet-stream';
  const name = sanitizeFilename(displayFilename ?? 'download');
  const disp = !forceDownload && INLINE_MIME_TYPES.has(mime) ? 'inline' : 'attachment';
  return `${disp}; filename="${name}"`;
}

/**
 * Strip characters that are unsafe in a Content-Disposition filename value.
 * Keeps alphanumeric, dots, dashes, underscores, and spaces.
 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\- ]/g, '_').slice(0, 255);
}
