import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class UpdateCommentDto {
  @IsString()
  @Length(1, 2000, { message: 'Comment must be between 1 and 2000 characters.' })
  @Transform(({ value }: { value: string }) => value?.trim())
  content: string;
}
