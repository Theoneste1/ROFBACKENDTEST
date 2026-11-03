import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * A submission attempt: a typed answer, files (multipart "files"/"file"), or
 * both. At least one of the two is required.
 */
export class CreateSubmissionDto {
  /** The published assignment being submitted to. */
  @IsUUID()
  assignmentId: string;

  /** The student's typed answer for this attempt. */
  @IsOptional()
  @IsString()
  @Length(1, 20000)
  @Transform(({ value }: { value: string }) => (typeof value === 'string' && value.trim() === '' ? undefined : value?.trim()))
  answerText?: string;

  /** Optional note from the student about this submission/revision. */
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  @Transform(({ value }: { value: string }) => value?.trim())
  note?: string;
}
