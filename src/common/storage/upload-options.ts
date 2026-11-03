import type { MulterOptions } from '@nestjs/platform-express/multer/interfaces/multer-options.interface.js';
import { memoryStorage } from 'multer';

import { FilePurpose } from '../../generated/prisma/client.js';
import { FILE_RULES } from './file-rules.js';
import { MAX_ATTACHMENTS } from './attachments.js';

/**
 * Multer options for an upload endpoint.
 *
 * Files are held in memory (never written to disk by multer) so that
 * authorization and content-type checks run before anything is stored.
 * The per-purpose size limit is enforced here as a hard cap per file.
 */
export function uploadOptions(purpose: FilePurpose, maxFiles = MAX_ATTACHMENTS + 1): MulterOptions {
  return {
    storage: memoryStorage(),
    limits: {
      fileSize: FILE_RULES[purpose].maxBytes,
      files:    maxFiles,
      fields:   30,
      parts:    30 + maxFiles,
    },
  };
}
