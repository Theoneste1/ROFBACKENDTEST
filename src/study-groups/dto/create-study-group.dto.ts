import { IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateStudyGroupDto {
  @IsString()
  @Length(2, 150)
  @Transform(({ value }: { value: string }) => value?.trim())
  name: string;

  @IsString()
  @Length(5, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  description: string;

  /**
   * Optional comma-separated tags or free-text metadata,
   * e.g. "Year 10, Algebra, Morning Session".
   */
  @IsOptional()
  @IsString()
  @Length(1, 500)
  @Transform(({ value }: { value: string }) => value?.trim())
  tags?: string;
}
