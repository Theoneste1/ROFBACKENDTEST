import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class RejectAssignmentDto {
  @IsString()
  @Length(5, 1000)
  @Transform(({ value }: { value: string }) => value?.trim())
  rejectionNote: string;
}
