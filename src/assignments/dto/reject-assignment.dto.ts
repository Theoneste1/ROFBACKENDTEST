import { IsISO8601, IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class RejectAssignmentDto {
  @IsString()
  @Length(5, 1000)
  @Transform(({ value }: { value: string }) => value?.trim())
  rejectionNote: string;
}

export class CloseAssignmentDto {
  /** Optional reason, kept in the assignment history. */
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  @Transform(({ value }: { value: string }) => value?.trim())
  note?: string;
}

export class ReopenAssignmentDto extends CloseAssignmentDto {
  /** New deadline (ISO-8601). Required when the current one has passed. */
  @IsOptional()
  @IsISO8601()
  deadline?: string;
}
