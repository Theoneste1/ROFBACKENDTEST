/**
 * Global exception filter — every error leaves the API in one shape:
 *
 *   {
 *     "statusCode": 409,
 *     "error":      "Conflict",
 *     "code":       "INVALID_STATE_TRANSITION",
 *     "message":    "Only SUBMITTED submissions can be assigned.",
 *     "details":    [...],              // optional (validation errors, etc.)
 *     "requestId":  "b2c1…",
 *     "path":       "/api/v1/submissions/…/assign",
 *     "timestamp":  "2026-11-03T10:00:00.000Z"
 *   }
 *
 * Unexpected errors are logged with the request id and returned as a generic
 * 500 — internal details never reach the client.
 *
 * The database's school-affiliation invariants (M10 triggers) are reported as 409
 * with their code and a generic message (the database message, which names the
 * student, is logged, not returned).
 */
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { MulterError } from 'multer';
import { Prisma } from '../../generated/prisma/client.js';
import { validationSummary } from '../errors/plain-validation.js';

/**
 * Plain-language messages (owner 2026-11-22: every error must say clearly what happened and what to do). Used where
 * the framework, the database or an unexpected failure would otherwise answer in technical terms.
 */
export const PLAIN = {
  internal:       'Something went wrong on our side and this could not be completed. Please try again in a moment. If it keeps happening, contact the Rwanda Olympiad Foundation team and give them the reference shown.',
  notFound:       "This item doesn't exist any more: it may have been removed or changed by someone else. Refresh the page and try again.",
  duplicate:      'This already exists: another record uses the same value. Change it and try again.',
  reference:      'This could not be done because other information depends on it, or it refers to something that was removed. Refresh the page and try again.',
  routeNotFound:  "This action isn't available. Refresh the page and try again; if it keeps happening, the platform may be updating, so try again in a few minutes.",
  invalidId:      "This link or item isn't valid. Go back and open it again from the list.",
  unauthorized:   'Please sign in to continue.',
  forbidden:      "You don't have permission to do this. If you think you should, contact an administrator.",
  tooMany:        'Too many attempts in a short time. Wait a minute, then try again.',
  badJson:        "The information sent couldn't be read. Refresh the page and try again.",
  tooLarge:       'What you sent is too large. Choose a smaller file (or a lower-resolution photo) and try again.',
  fileTooLarge:   'The file is too large. Choose a smaller file (or a lower-resolution photo) and try again.',
  tooManyFiles:   'Too many files at once. Send fewer files and try again.',
  unexpectedFile: "This upload isn't expected here. Refresh the page and try again.",
  uploadRejected: "This upload couldn't be accepted. Check the file and try again.",
} as const;

/** Nest's own default texts ("Forbidden resource", "Cannot GET /x", "Validation failed (uuid is expected)") in plain words. */
function plainHttpMessage(status: number, message: string): { message: string; code?: string } | null {
  if (status === 404 && /^Cannot (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /.test(message)) return { message: PLAIN.routeNotFound, code: 'ROUTE_NOT_FOUND' };
  if (status === 400 && /^Validation failed \((uuid|numeric string|boolean string|enum)/i.test(message)) return { message: PLAIN.invalidId, code: 'INVALID_REFERENCE' };
  if (status === 401 && /^Unauthorized$/i.test(message)) return { message: PLAIN.unauthorized };
  if (status === 403 && /^Forbidden( resource)?$/i.test(message)) return { message: PLAIN.forbidden };
  if (status === 429) return { message: PLAIN.tooMany };
  if (status === 413 && /^(Payload Too Large|request entity too large)$/i.test(message)) return { message: PLAIN.tooLarge };
  if (status === 404 && /^Not Found$/i.test(message)) return { message: PLAIN.notFound };
  return null;
}

interface ErrorBody {
  statusCode: number;
  error:      string;
  code:       string;
  message:    string;
  details?:   unknown;
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

/** Raised by the M10 triggers (per statement); the application keeps both invariants itself, so
 *  reaching one means a write bypassed SchoolAffiliationService. */
const AFFILIATION_INTEGRITY = /\b(AFFILIATION_ONE_CURRENT|AFFILIATION_SCHOOL_MISMATCH)\b/;

function reason(status: number): string {
  const name = HttpStatus[status];
  if (!name) return 'Error';
  return name
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request & { id?: string }>();
    const res = ctx.getResponse<Response>();

    const body = this.toBody(exception);
    if (body.code === 'AFFILIATION_ONE_CURRENT' || body.code === 'AFFILIATION_SCHOOL_MISMATCH') {
      this.logger.warn(`[${req.id ?? '-'}] ${req.method} ${req.originalUrl} → ${body.statusCode} ${(exception as Error).message}`);
    }

    if (body.statusCode >= 500) {
      this.logger.error(
        `[${req.id ?? '-'}] ${req.method} ${req.originalUrl} → ${body.statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    // A streamed download may already have sent headers.
    if (res.headersSent) {
      res.end();
      return;
    }

    // A busy database is temporary: tell clients when to try again.
    if (body.code === 'DATABASE_BUSY') res.setHeader?.('Retry-After', '2');

    res.status(body.statusCode).json({
      ...body,
      requestId: req.id,
      path:      req.originalUrl,
      timestamp: new Date().toISOString(),
    });
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception);
    }
    // Before the Prisma mapping: the driver may wrap the trigger error in any Prisma error class.
    const integrity = exception instanceof Error ? AFFILIATION_INTEGRITY.exec(exception.message) : null;
    if (integrity) {
      return {
        statusCode: 409,
        error:      'Conflict',
        code:       integrity[1],
        message:    integrity[1] === 'AFFILIATION_ONE_CURRENT'
          ? 'A student can have only one current school claim; nothing was changed.'
          : "The student's current school claim must be for the student's school; nothing was changed.",
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrismaError(exception);
    }
    if (exception instanceof MulterError) {
      return this.fromMulterError(exception);
    }
    // The JSON body parser's own errors (a body that is not JSON, or too large): a client problem, not a server failure.
    const parser = (exception as { type?: unknown } | null)?.type;
    if (parser === 'entity.parse.failed') return { statusCode: 400, error: 'Bad Request', code: 'INVALID_JSON', message: PLAIN.badJson };
    if (parser === 'entity.too.large') return { statusCode: 413, error: 'Payload Too Large', code: 'PAYLOAD_TOO_LARGE', message: PLAIN.tooLarge };
    return {
      statusCode: 500,
      error:      'Internal Server Error',
      code:       'INTERNAL_ERROR',
      message:    PLAIN.internal,
    };
  }

  private fromHttpException(exception: HttpException): ErrorBody {
    const status   = exception.getStatus();
    const response = exception.getResponse();
    const base = {
      statusCode: status,
      error:      reason(status),
      code:       STATUS_CODES[status] ?? 'ERROR',
      message:    exception.message,
    };

    if (typeof response === 'string') {
      const plain = plainHttpMessage(status, response);
      return { ...base, ...(plain && { code: plain.code ?? base.code }), message: plain?.message ?? response };
    }

    const r = response as Record<string, unknown>;

    // ValidationPipe: { message: string[] }. The messages stay in details (forms match them to their fields); the
    // message is the first problem in plain words.
    if (Array.isArray(r['message'])) {
      return {
        ...base,
        code:    'VALIDATION_FAILED',
        message: validationSummary(r['message'].filter((m): m is string => typeof m === 'string')),
        details: r['message'],
      };
    }

    const code = typeof r['code'] === 'string' ? r['code'] : undefined;
    const message = typeof r['message'] === 'string' ? r['message'] : base.message;
    // Only the framework's own refusals (without a code of ours) are rewritten; our AppErrors keep their messages.
    const plain = code ? null : plainHttpMessage(status, message);
    return {
      ...base,
      code:    code ?? plain?.code ?? base.code,
      message: plain?.message ?? message,
      ...(r['details'] !== undefined && { details: r['details'] }),
    };
  }

  private fromPrismaError(e: Prisma.PrismaClientKnownRequestError): ErrorBody {
    switch (e.code) {
      case 'P2002': {
        const target = (e.meta?.['target'] as string[] | string | undefined) ?? undefined;
        return {
          statusCode: 409,
          error:      'Conflict',
          code:       'DUPLICATE',
          message:    PLAIN.duplicate,
          ...(target && { details: { fields: target } }),
        };
      }
      case 'P2025':
        return { statusCode: 404, error: 'Not Found', code: 'NOT_FOUND', message: PLAIN.notFound };
      case 'P2003':
        return {
          statusCode: 409,
          error:      'Conflict',
          code:       'REFERENCE_CONSTRAINT',
          message:    PLAIN.reference,
        };
      // "Unable to start a transaction in the given time": every pooled connection stayed busy for
      // longer than the transaction may wait. Temporary, nothing was changed: 503, retry later.
      case 'P2028':
        return {
          statusCode: 503,
          error:      'Service Unavailable',
          code:       'DATABASE_BUSY',
          message:    'The server is busy. Nothing was changed; please try again in a moment.',
        };
      default:
        return {
          statusCode: 500,
          error:      'Internal Server Error',
          code:       'INTERNAL_ERROR',
          message:    PLAIN.internal,
        };
    }
  }

  private fromMulterError(e: MulterError): ErrorBody {
    if (e.code === 'LIMIT_FILE_SIZE') {
      return { statusCode: 413, error: 'Payload Too Large', code: 'FILE_TOO_LARGE', message: PLAIN.fileTooLarge };
    }
    const message = e.code === 'LIMIT_FILE_COUNT' || e.code === 'LIMIT_PART_COUNT' ? PLAIN.tooManyFiles
      : e.code === 'LIMIT_UNEXPECTED_FILE' ? PLAIN.unexpectedFile
      : PLAIN.uploadRejected;
    return { statusCode: 400, error: 'Bad Request', code: 'UPLOAD_REJECTED', message };
  }
}
