import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsISO8601, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';

import { TEACHER_DELEGATIONS } from '../../auth/override-policy.js';
import { PaginationQueryDto } from '../../common/pagination.js';
import { GradeLevel, OlympiadLevel, TeacherSchoolRole } from '../../generated/prisma/client.js';
import { STUDENT_SCOPES, type StudentScope } from '../teacher-scope.js';

/** Most students one request may name (larger sets: the bulk operations). */
export const MAX_STUDENTS_PER_REQUEST = 200;

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

  /** PRIMARY (the school's designated main contact) or SECONDARY (owner decision 2026-11-19). */
  @IsOptional()
  @IsEnum(TeacherSchoolRole)
  role?: TeacherSchoolRole;
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

  /**
   * Which students it covers (TS-4): SCHOOL (default — every student the teacher sees through their schools),
   * ASSIGNED (only students assigned to the teacher) or SELECTED (only studentIds).
   */
  @IsOptional()
  @IsIn(STUDENT_SCOPES)
  studentScope?: StudentScope;

  /** SELECTED only (required then): the students, each visible to the teacher. */
  @ValidateIf((o: CreateDelegationDto) => o.studentScope === 'SELECTED' || o.studentIds !== undefined)
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_STUDENTS_PER_REQUEST) @IsUUID('all', { each: true })
  studentIds?: string[];
}

/** GET /teacher/students */
export class ListTeacherStudentsDto extends PaginationQueryDto {
  /** One of the teacher's schools (default: all of them). */
  @IsOptional() @IsUUID() schoolId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(GradeLevel)
  gradeLevel?: GradeLevel;

  /** The students' Olympiad level (owner 2026-11-21): JUNIOR, MIDDLE or SENIOR. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(OlympiadLevel)
  olympiadLevel?: OlympiadLevel;

  /** Name or username contains. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  @Transform(trim)
  q?: string;

  /** How the teacher sees them: SCHOOL (verified students of their schools) or ASSIGNED (assigned to them). */
  @IsOptional()
  @IsIn(['SCHOOL', 'ASSIGNED'])
  access?: 'SCHOOL' | 'ASSIGNED';
}


/** POST /admin/teacher-students — assign students to one teacher. */
export class AssignTeacherStudentsDto {
  @IsUUID() teacherId: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_STUDENTS_PER_REQUEST) @IsUUID('all', { each: true })
  studentIds: string[];

  /** Required for any student who is not a verified student of the teacher's schools (TS-3); audited. */
  @IsOptional() @IsString() @Length(5, 500) @Transform(trim)
  reason?: string;
}

/** POST /admin/teacher-students/reassign — move students from one teacher to another. */
export class ReassignTeacherStudentsDto {
  @IsUUID() fromTeacherId: string;
  @IsUUID() toTeacherId: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_STUDENTS_PER_REQUEST) @IsUUID('all', { each: true })
  studentIds: string[];

  @IsOptional() @IsString() @Length(5, 500) @Transform(trim)
  reason?: string;
}

/** GET /admin/teacher-students */
export class ListTeacherStudentAssignmentsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() teacherId?: string;
  @IsOptional() @IsUUID() studentId?: string;
  /** The student's school. */
  @IsOptional() @IsUUID() schoolId?: string;

  @IsOptional()
  @Transform(bool)
  @IsBoolean()
  isActive?: boolean;
}

/** GET /admin/schools/:id/access/students */
export class SchoolAccessStudentsDto extends PaginationQueryDto {
  @IsOptional() @IsString() @Length(1, 100) @Transform(trim)
  q?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsEnum(GradeLevel)
  gradeLevel?: GradeLevel;

  /** The student's current claim for this school. */
  @IsOptional() @IsIn(['VERIFIED', 'PENDING'])
  verification?: 'VERIFIED' | 'PENDING';

  /** true: assigned to at least one teacher; false: to none. */
  @IsOptional() @Transform(bool) @IsBoolean()
  assigned?: boolean;

  /** Only students assigned to this teacher. */
  @IsOptional() @IsUUID()
  teacherId?: string;
}

/** POST /admin/teachers/:id/delegations/:overrideId/students */
export class DelegationStudentsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(MAX_STUDENTS_PER_REQUEST) @IsUUID('all', { each: true })
  studentIds: string[];
}

/** PUT /admin/teachers/:id/test-submission (owner 2026-11-21): revoke (allowed false, reason required) or restore. */
export class SetTeacherTestSubmissionDto {
  @IsBoolean()
  allowed: boolean;

  /** Required to revoke (3–500 characters); optional when restoring. Recorded in the audit log. */
  @IsOptional() @IsString() @Length(0, 500)
  reason?: string;
}
