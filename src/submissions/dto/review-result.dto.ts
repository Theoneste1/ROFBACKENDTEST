import { IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class ApproveResultDto {
  @IsOptional()
  @IsString()
  @Length(2, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  adminFeedback?: string;
}

export class RejectResultDto {
  @IsString()
  @Length(5, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  rejectionReason: string;
}
