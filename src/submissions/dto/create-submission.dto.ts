import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateSubmissionDto {
  /** The published assignment being submitted to. */
  @IsUUID()
  assignmentId: string;

  /** Optional note from the student about this submission/revision. */
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  @Transform(({ value }: { value: string }) => value?.trim())
  note?: string;
}
