/**
 * @deprecated No longer used (2026-11-03). Courses no longer go through a
 * mentor-submission/approval workflow (admins publish/unpublish directly).
 * Kept only because existing files are not deleted without approval; safe to remove.
 */
import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class RejectCourseDto {
  @IsString()
  @Length(5, 1000)
  @Transform(({ value }: { value: string }) => value?.trim())
  rejectionNote: string;
}
