import { IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Admin accepts a mentor's review.
 *
 * `coordinationNote` is an INTERNAL note (e.g. "checked with head mentor").
 * It is never shown to the student and is not academic feedback — formal
 * feedback is written by mentors only.
 */
export class ApproveResultDto {
  @IsOptional()
  @IsString()
  @Length(2, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  coordinationNote?: string;
}

/** Admin sends a mentor's review back for rework (visible to the mentor). */
export class RejectResultDto {
  @IsString()
  @Length(5, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  rejectionReason: string;
}
