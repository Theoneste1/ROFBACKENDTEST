import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateCourseDto {
  @IsString()
  @Length(3, 200)
  @Transform(({ value }: { value: string }) => value?.trim())
  title: string;

  @IsString()
  @Length(10, 2000)
  @Transform(({ value }: { value: string }) => value?.trim())
  description: string;

  /**
   * Mathematics area — e.g. "Algebra", "Geometry",
   * "Number Theory", "Combinatorics".
   */
  @IsString()
  @Length(2, 100)
  @Transform(({ value }: { value: string }) => value?.trim())
  subject: string;
}
