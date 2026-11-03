import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Correcting a PUBLISHED result.
 *
 * Administrators must not grade, so they cannot change a score themselves.
 * Instead they REOPEN the result: it is withdrawn from the student, its points
 * are removed, and it goes back to the mentor with this note. The mentor
 * re-scores and the normal approve → publish flow runs again. The previous
 * score stays on the superseded review cycle (review history) and in the audit log.
 */
export class ReopenResultDto {
  @IsString()
  @Length(5, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  reopenNote: string;
}
