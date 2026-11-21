import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsOptional, IsUUID, ValidateIf, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PaginationQueryDto } from '../../common/pagination.js';

export class CreateMentorAssignmentDto {
  @IsUUID()
  mentorId: string;

  @IsUUID()
  courseId: string;

  @IsUUID()
  divisionId: string;
}

export class ListMentorAssignmentsDto extends PaginationQueryDto {
  @IsOptional() @IsUUID() mentorId?: string;
  @IsOptional() @IsUUID() courseId?: string;
  @IsOptional() @IsUUID() divisionId?: string;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;
}

/** One course × division pair. */
export class CoursePairDto {
  @IsUUID() courseId: string;
  @IsUUID() divisionId: string;
}

/**
 * POST /admin/mentor-assignments/bulk (owner 2026-11-22): assign a coach to many course × division pairs at once —
 *   ALL       every course every active division offers;
 *   DIVISION  every course one division offers (Junior, Middle, Senior or any division an Administrator created);
 *   PAIRS     the pairs chosen one by one.
 * `dryRun: true` previews exactly what would change (NEW, REACTIVATE, ALREADY_ASSIGNED) and changes nothing.
 */
export class BulkMentorAssignmentDto {
  @IsUUID() mentorId: string;

  @IsIn(['ALL', 'DIVISION', 'PAIRS']) scope: 'ALL' | 'DIVISION' | 'PAIRS';

  @ValidateIf((o: BulkMentorAssignmentDto) => o.scope === 'DIVISION')
  @IsUUID() divisionId?: string;

  @ValidateIf((o: BulkMentorAssignmentDto) => o.scope === 'PAIRS')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CoursePairDto)
  pairs?: CoursePairDto[];

  @IsOptional() @IsBoolean() dryRun?: boolean;
}
