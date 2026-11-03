import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateCommentDto {
  /**
   * The comment body. 1–2000 characters.
   * Trimmed before storage.
   */
  @IsString()
  @Length(1, 2000, { message: 'Comment must be between 1 and 2000 characters.' })
  @Transform(({ value }: { value: string }) => value?.trim())
  content: string;

  /**
   * If set, this comment is a reply to the specified parent comment in the
   * same thread. Only one level of nesting is supported.
   */
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
