import { IsISO8601, IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

/** Mentor asks the student for a new attempt. */
export class RequestResubmissionDto {
  /** What the student should change. Shown to the student. */
  @IsString()
  @Length(5, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  note: string;

  /**
   * When the new attempt is due (ISO-8601, within 60 days). Defaults to the
   * assignment deadline or 7 days from now, whichever is later.
   */
  @IsOptional()
  @IsISO8601()
  dueAt?: string;
}
