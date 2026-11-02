import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * A domain error carrying a stable, machine-readable `code`.
 *
 * The frontend should branch on `code` (e.g. "DEADLINE_PASSED"), never on the
 * human-readable message, which may change.
 *
 *   throw new AppError(HttpStatus.CONFLICT, 'INVALID_STATE_TRANSITION', 'Only ...');
 */
export class AppError extends HttpException {
  constructor(
    status:  HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

/** Shorthand for the most common case: a request that conflicts with current state. */
export const invalidState = (message: string, details?: unknown) =>
  new AppError(HttpStatus.CONFLICT, 'INVALID_STATE_TRANSITION', message, details);
