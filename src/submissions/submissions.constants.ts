import { BadRequestException } from '@nestjs/common';
import { diskStorage } from 'multer';
import { extname, join } from 'path';
import { randomUUID } from 'crypto';

/** Allowed MIME types for student submission files. */
const ALLOWED_SUBMISSION_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/gif',
  'application/zip',
  'application/x-zip-compressed',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

/** Allowed MIME types for mentor feedback files. */
const ALLOWED_FEEDBACK_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

/** 20 MB max for student submissions. */
export const SUBMISSION_MAX_FILE_SIZE = 20 * 1024 * 1024;

/** 10 MB max for mentor feedback files. */
export const FEEDBACK_MAX_FILE_SIZE = 10 * 1024 * 1024;

export const submissionFileFilter = (
  _req: any,
  file: Express.Multer.File,
  cb: (error: Error | null, accept: boolean) => void,
) => {
  if (ALLOWED_SUBMISSION_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new BadRequestException(`File type "${file.mimetype}" is not permitted for submissions.`), false);
  }
};

export const feedbackFileFilter = (
  _req: any,
  file: Express.Multer.File,
  cb: (error: Error | null, accept: boolean) => void,
) => {
  if (ALLOWED_FEEDBACK_TYPES.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new BadRequestException(`File type "${file.mimetype}" is not permitted for feedback.`), false);
  }
};

export const submissionStorage = diskStorage({
  destination: join(process.cwd(), 'uploads', 'submissions'),
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
});

export const feedbackStorage = diskStorage({
  destination: join(process.cwd(), 'uploads', 'feedback'),
  filename: (_req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname)}`),
});
