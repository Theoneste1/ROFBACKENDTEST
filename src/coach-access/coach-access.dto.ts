import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

import type { CoachCapability } from '../generated/prisma/client.js';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** GET /coach/students. */
export class CoachStudentsQueryDto {
  @IsOptional() @Transform(trim) @IsString() @Length(1, 100) q?: string;
  /** One of my programmes (a Discipline id). */
  @IsOptional() @IsUUID() programmeId?: string;
  /** An Olympiad level code (JUNIOR, MIDDLE, SENIOR …). */
  @IsOptional() @Matches(/^[A-Z][A-Z0-9_]{1,29}$/, { message: 'division must be a level code such as JUNIOR.' }) division?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** PUT /admin/coaches/:id/programme-access: take a capability away (allowed false, reason required) or give it back. */
export class SetCoachAccessDto {
  @IsUUID() programmeId: string;
  @IsIn(['STUDENTS', 'COURSES', 'MARKING', 'RESULTS'], { message: 'capability must be STUDENTS, COURSES, MARKING or RESULTS.' })
  capability: CoachCapability;
  @IsBoolean() allowed: boolean;
  @IsOptional() @Transform(trim) @IsString() @Length(0, 500, { message: 'reason must be at most 500 characters.' }) reason?: string;
}
