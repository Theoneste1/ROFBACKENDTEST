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
    return {
      statusCode: 500,
      error:      'Internal Server Error',
      code:       'INTERNAL_ERROR',
      message:    'An unexpected error occurred.',
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
      return { ...base, message: response };
    }

    const r = response as Record<string, unknown>;

    // ValidationPipe: { message: string[] }
    if (Array.isArray(r['message'])) {
      return {
        ...base,
        code:    'VALIDATION_FAILED',
        message: 'Request validation failed.',
        details: r['message'],
      };
    }

    return {
      ...base,
      code:    typeof r['code'] === 'string' ? r['code'] : base.code,
      message: typeof r['message'] === 'string' ? r['message'] : base.message,
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
          message:    'A record with the same unique value already exists.',
          ...(target && { details: { fields: target } }),
        };
      }
      case 'P2025':
        return { statusCode: 404, error: 'Not Found', code: 'NOT_FOUND', message: 'Record not found.' };
      case 'P2003':
        return {
          statusCode: 409,
          error:      'Conflict',
          code:       'REFERENCE_CONSTRAINT',
          message:    'The operation conflicts with related records.',
        };
      default:
        return {
          statusCode: 500,
          error:      'Internal Server Error',
          code:       'INTERNAL_ERROR',
          message:    'An unexpected error occurred.',
        };
    }
  }

  private fromMulterError(e: MulterError): ErrorBody {
    if (e.code === 'LIMIT_FILE_SIZE') {
      return { statusCode: 413, error: 'Payload Too Large', code: 'FILE_TOO_LARGE', message: 'The uploaded file is too large.' };
    }
    return { statusCode: 400, error: 'Bad Request', code: 'UPLOAD_REJECTED', message: e.message };
  }
}
