/**
 * score.utils.ts
 *
 * Single source of truth for score validation and percentage computation.
 * All service methods that deal with scores call these functions so that
 * the rules are applied consistently and can be changed in one place.
 */

import { BadRequestException } from '@nestjs/common';

/**
 * Validate a score against the assignment's maximumMarks.
 *
 * Throws `BadRequestException` with a clear message on any violation:
 *   - score is not a safe integer
 *   - score is negative
 *   - score exceeds maximumMarks
 *   - maximumMarks is zero or negative (configuration error)
 */
export function validateScore(score: number, maximumMarks: number, context = 'Score'): void {
  // Guard against misconfigured maximumMarks at the DB level.
  if (!Number.isInteger(maximumMarks) || maximumMarks <= 0) {
    throw new BadRequestException(
      `Assignment has an invalid maximumMarks value (${maximumMarks}). ` +
      `Please correct the assignment before submitting marks.`,
    );
  }

  if (!Number.isInteger(score)) {
    throw new BadRequestException(`${context} must be a whole number.`);
  }

  if (score < 0) {
    throw new BadRequestException(`${context} cannot be negative.`);
  }

  if (score > maximumMarks) {
    throw new BadRequestException(
      `${context} (${score}) exceeds the assignment's maximum marks (${maximumMarks}).`,
    );
  }
}

/**
 * Compute percentage from score and maximumMarks.
 *
 * Returns a number rounded to 2 decimal places.
 * Guards against zero / negative maximumMarks — returns 0 rather than
 * dividing by zero, and validates first so callers always get a meaningful
 * error before reaching this calculation.
 */
export function computePercentage(score: number, maximumMarks: number): number {
  if (!Number.isInteger(maximumMarks) || maximumMarks <= 0) {
    // Safety net — should have been caught by validateScore first.
    return 0;
  }
  return parseFloat(((score / maximumMarks) * 100).toFixed(2));
}
