/** TEACHER_APPLICATION bulk actions — the selection (2026-11-20; validated by the generic routes). */
import { OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsUUID, ValidateIf, ValidateNested } from 'class-validator';

import { DECISION_MAX_IDS } from '../../bulk/bulk-decisions.js';
import { ListTeacherApplicationsDto } from '../dto/teacher-application.dto.js';

/** The filter of GET /admin/teacher-applications (status), without paging. */
export class TeacherApplicationBulkFilterDto extends OmitType(ListTeacherApplicationsDto, ['page', 'limit'] as const) {}

/** `{ mode: 'ids', ids }` (≤ 1000 applications) or `{ mode: 'filter', filter }` (every application matching, ≤ 10 000). */
export class TeacherApplicationBulkSelectionDto {
  @IsIn(['ids', 'filter']) mode: 'ids' | 'filter';

  @ValidateIf((o: TeacherApplicationBulkSelectionDto) => o.mode === 'ids')
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(DECISION_MAX_IDS) @IsUUID('all', { each: true })
  ids?: string[];

  @ValidateIf((o: TeacherApplicationBulkSelectionDto) => o.mode === 'filter')
  @ValidateNested() @Type(() => TeacherApplicationBulkFilterDto)
  filter?: TeacherApplicationBulkFilterDto;
}
