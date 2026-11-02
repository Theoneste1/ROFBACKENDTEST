import { IsInt, IsString, Length, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

const ABSOLUTE_MAX_SCORE = 10_000;

/**
 * Admin corrects a published result.
 * Requires a mandatory correction note — silent score changes are not permitted.
 */
export class CorrectResultDto {
  @IsInt({ message: 'Score must be a whole number.' })
  @Min(0, { message: 'Score cannot be negative.' })
  @Max(ABSOLUTE_MAX_SCORE, { message: `Score cannot exceed ${ABSOLUTE_MAX_SCORE}.` })
  @Type(() => Number)
  score: number;

  @IsString()
  @Length(5, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  correctionNote: string;
}
