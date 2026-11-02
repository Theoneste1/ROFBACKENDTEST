/**
 * @deprecated No longer used (2026-11-03). The four Mathematics courses are
 * fixed and created by the seed; courses cannot be created through the API.
 * Kept only because existing files are not deleted without approval; safe to remove.
 */
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
