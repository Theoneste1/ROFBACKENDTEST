import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class UpdateCourseDto {
  @IsOptional()
  @IsString()
  @Length(3, 200)
  @Transform(({ value }: { value: string }) => value?.trim())
  title?: string;

  @IsOptional()
  @IsString()
  @Length(10, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  description?: string;

  /** Display order on course lists (lower first). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  /** Turn the course's discussions on or off (existing threads stay readable). */
  @IsOptional()
  @IsBoolean()
  discussionsEnabled?: boolean;
}
