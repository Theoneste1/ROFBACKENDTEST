import {
  IsInt,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Score validation layers:
 *   1. @IsInt()  — must be a whole number (rejects floats, strings, booleans)
 *   2. @Min(0)   — no negative scores
 *   3. @Max      — absolute ceiling; real ceiling against maximumMarks is enforced
 *                  in the service after fetching the assignment
 */
const ABSOLUTE_MAX_SCORE = 10_000;

export class MarkSubmissionDto {
  @IsInt({ message: 'Score must be a whole number.' })
  @Min(0, { message: 'Score cannot be negative.' })
  @Max(ABSOLUTE_MAX_SCORE, { message: `Score cannot exceed ${ABSOLUTE_MAX_SCORE}.` })
  @Type(() => Number)
  score: number;

  @IsString()
  @Length(2, 5000)
  mentorFeedback: string;
}
