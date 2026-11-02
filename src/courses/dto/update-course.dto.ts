import { IsOptional, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

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

  @IsOptional()
  @IsString()
  @Length(2, 100)
  @Transform(({ value }: { value: string }) => value?.trim())
  subject?: string;
}
