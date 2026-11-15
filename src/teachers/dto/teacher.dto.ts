import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length } from 'class-validator';

import { TEACHER_DELEGATIONS } from '../../auth/override-policy.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { GradeLevel } from '../../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const bool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

/** POST /admin/teacher-assignments — give a Teacher a school. */
export class CreateTeacherSchoolDto {
  @IsUUID()
  teacherId: string;

  @IsUUID()
  schoolId: string;
}

/** GET /admin/teacher-assignments */
export class ListTeacherSchoolsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() teacherId?: string;
  @IsOptional() @IsUUID() schoolId?: string;

  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  isActive?: boolean;
}

/** POST /admin/teachers/:id/delegations — grant one teacher delegation. */
export class CreateDelegationDto {
  /** students.viewProfile, students.viewProgress or submissions.submitOnBehalf. */
  @IsIn(TEACHER_DELEGATIONS)
  permission: string;

  /** Why it is needed (kept in the audit trail). */
  @IsString()
  @Length(3, 500)
  @Transform(trim)
  reason: string;

  /** When it stops applying (ISO 8601, in the future). Omit for no expiry. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

/** GET /teacher/students */
export class ListTeacherStudentsDto extends PaginationQueryDto {
  /** One of the teacher's schools (default: all of them). */
  @IsOptional() @IsUUID() schoolId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(GradeLevel)
  gradeLevel?: GradeLevel;

  /** Name or username contains. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  q?: string;
}
