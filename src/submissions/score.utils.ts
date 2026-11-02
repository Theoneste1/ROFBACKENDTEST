/**
 * score.utils.ts
 *
 * Single source of truth for score validation, percentage and leaderboard
 * point computation. All service methods that deal with scores call these
 * functions so the rules are applied consistently and can change in one place.
 */

import { HttpStatus } from '@nestjs/common';
import { AppError } from '../common/errors/app-error.js';

/**
 * Validate a score against the assignment's maximumMarks.
 *
 * Throws with code INVALID_SCORE on any violation:
 *   - score is not a safe integer
 *   - score is negative
 *   - score exceeds maximumMarks
 *   - maximumMarks is zero or negative (configuration error)
 */
export function validateScore(score: number, maximumMarks: number, context = 'Score'): void {
  if (!Number.isInteger(maximumMarks) || maximumMarks <= 0) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_SCORE',
      `Assignment has an invalid maximumMarks value (${maximumMarks}).`,
    );
  }
  if (!Number.isInteger(score)) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SCORE', `${context} must be a whole number.`);
  }
  if (score < 0) {
    throw new AppError(HttpStatus.BAD_REQUEST, 'INVALID_SCORE', `${context} cannot be negative.`);
  }
  if (score > maximumMarks) {
    throw new AppError(
      HttpStatus.BAD_REQUEST,
      'INVALID_SCORE',
      `${context} (${score}) exceeds the assignment's maximum marks (${maximumMarks}).`,
    );
  }
}

/** Percentage rounded to 2 decimals; 0 for a misconfigured maximum. */
export function computePercentage(score: number, maximumMarks: number): number {
  if (!Number.isInteger(maximumMarks) || maximumMarks <= 0) return 0;
  return parseFloat(((score / maximumMarks) * 100).toFixed(2));
}

/**
 * Leaderboard points granted for a published result: the assignment's points
 * scaled by the score (e.g. 15/20 on a 40-point assignment → 30 points).
 * Uses the same unit as `Assignment.points`, so totals stay consistent when a
 * result is reopened and re-scored.
 */
export function computePointsAwarded(score: number, maximumMarks: number, assignmentPoints: number): number {
  if (maximumMarks <= 0 || assignmentPoints <= 0) return 0;
  return Math.round((assignmentPoints * score) / maximumMarks);
}
